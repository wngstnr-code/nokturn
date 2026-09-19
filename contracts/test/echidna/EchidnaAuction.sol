// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AuctionHouse} from "../../src/AuctionHouse.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../../src/interfaces/ISolverRegistry.sol";
import {IntentLib} from "../../src/libraries/IntentLib.sol";
import {Execution, Intent, IntentFlags, IntentKind, Session, SessionMask} from "../../src/types/Types.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSolverRegistry} from "../mocks/MockSolverRegistry.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";

/// @dev A committer. Echidna cannot sign, so the owner is a contract and the
/// signature is checked through EIP-1271 rather than through a key. Anyone may
/// relay a commitment, and the signature is what stops anyone from filling the
/// book, so the accepting side of it has to exist somewhere.
contract AuctionActor {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }

    function approve(IERC20 token, address spender) external {
        token.approve(spender, type(uint256).max);
    }
}

/// @dev I10 says anyone, so the calls that anyone is allowed to make are made by
/// somebody who committed nothing and owns nothing.
contract AuctionStranger {
    function abortAuction(AuctionHouse house, uint64 auctionId) external {
        house.abortAuction(auctionId);
    }

    function refundEscrow(AuctionHouse house, bytes32 intentHash) external {
        house.refundEscrow(intentHash);
    }
}

contract AuctionChallenger {
    function challenge(AuctionHouse house, uint64 auctionId, uint256 betterPrice) external {
        house.challenge(auctionId, betterPrice);
    }

    function approve(IERC20 token, address spender) external {
        token.approve(spender, type(uint256).max);
    }
}

/// @notice I10 and I13 under echidna. Escrow that an auction did not spend is
/// always recoverable once the auction settles, by anyone, and a closing print is
/// never published below the volume or the participant floor.
///
/// Both branches of I13 are reached. Prints are withheld below the floor and
/// published above it, which matters because a campaign that only ever reaches the
/// withholding branch has not tested the one that writes a number the outside world
/// reads.
///
/// Getting there was a clock problem rather than a book problem. Probes on each
/// stage showed close auctions being booked, frozen, crossed and executed, and only
/// the print never published, and the participant floor was never the reason. The
/// first AUCTION_CLOSE window sits about seventy thousand seconds past where
/// echidna starts its clock, which at this step was most of a thousand call
/// sequence, so the sequence ran out before the freeze, the cross and the execute
/// behind it. The sequence is longer now, three books in four are sized over the
/// print floor, and actAdvance stops a three hundred second freeze window being
/// spent on a draw for one action out of a dozen.
///
/// The phases only mean anything in order, and echidna has no warp, so the order
/// is not driven from here. Every phase is its own action that returns when the
/// clock or the phase is wrong, and the search is what finds the orderings that
/// work. That is slower than the foundry campaign, which runs a whole auction per
/// call, and it is also the only shape available without cheatcodes.
contract EchidnaAuction {
    uint256 internal constant WAD = 1e18;
    uint16 internal constant BPS = 10_000;

    /// AuctionHouse.Phase, which is internal to that contract but reachable
    /// through auctionState.
    uint8 internal constant PHASE_DISCLOSURE = 1;
    uint8 internal constant PHASE_FROZEN = 2;
    uint8 internal constant PHASE_CROSSED = 3;
    uint8 internal constant PHASE_EXECUTED = 4;
    uint8 internal constant PHASE_ABORTED = 5;

    struct Committed {
        bytes32 intentHash;
        uint64 auctionId;
        address owner;
        address sellToken;
        uint256 sellAmount;
    }

    AuctionHouse internal house;
    SessionManager internal sessions;
    PriceOracle internal oracle;
    MockPermit2 internal permit2;
    MockSolverRegistry internal registry;
    MockSwapAdapter internal venue;

    MockERC20 internal quote;
    MockERC20 internal base;
    MockAggregator internal quoteFeed;
    MockAggregator internal baseFeed;

    AuctionStranger internal stranger;
    AuctionChallenger internal challenger;
    address internal treasury = address(0x7EA);
    address[5] internal actors;

    Committed[] internal committed;
    uint64[] internal auctionIds;
    uint32[] internal printDays;
    mapping(uint64 => bool) internal knownAuction;
    mapping(uint32 => bool) internal knownPrintDay;
    mapping(bytes32 => bool) internal refunded;
    mapping(uint8 => uint64) internal lastBooked;

    uint256 internal nextNonce = 1;

    uint256 public commitsAccepted;
    uint256 public freezes;
    uint256 public crossesSubmitted;
    uint256 public crossesExecuted;
    uint256 public auctionsAborted;
    uint256 public refundsPaid;
    uint256 public printsPublished;

    uint256 public doubleRefunds;
    uint256 public refundDenied;
    uint256 public printBelowFloor;

    constructor() {
        quote = new MockERC20("Global Dollar", "USDG", 6);
        base = new MockERC20("Nvidia", "NVDA", 18);
        quoteFeed = new MockAggregator(8, "USDG / USD");
        baseFeed = new MockAggregator(8, "RHNVDA / USD");
        venue = new MockSwapAdapter();
        permit2 = new MockPermit2();
        registry = new MockSolverRegistry();

        sessions = new SessionManager(address(this));
        uint64[] memory dst = new uint64[](2);
        dst[0] = uint64(block.timestamp) - 30 days;
        dst[1] = uint64(block.timestamp) + 300 days;
        sessions.setDstBoundaries(dst);

        oracle = new PriceOracle(ISessionManager(address(sessions)), address(this));
        oracle.setFeed(address(quote), address(quoteFeed), 6000, 20_000);
        oracle.setFeed(address(base), address(baseFeed), 6000, 20_000);
        oracle.setTwapSource(address(quote), address(venue), address(base), 1800);
        oracle.setTwapSource(address(base), address(venue), address(quote), 1800);
        venue.setRate(address(quote), address(base), 1e18);
        venue.setRate(address(base), address(quote), 200e18);

        house = new AuctionHouse(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            ISolverRegistry(address(registry)),
            ISignatureTransfer(address(permit2)),
            IERC20(address(quote)),
            treasury,
            address(this),
            address(this)
        );
        house.setAuctionTokenAllowed(address(base), true);
        registry.setActive(address(this), true);

        stranger = new AuctionStranger();
        challenger = new AuctionChallenger();
        registry.setActive(address(challenger), true);

        for (uint256 k = 0; k < 5; ++k) {
            AuctionActor a = new AuctionActor();
            a.approve(IERC20(address(quote)), address(permit2));
            a.approve(IERC20(address(base)), address(permit2));
            actors[k] = address(a);
        }

        // The solver and the challenger each post a bond out of their own pocket.
        quote.mint(address(this), 1_000_000e6);
        quote.approve(address(house), type(uint256).max);
        quote.mint(address(challenger), 1_000_000e6);
        challenger.approve(IERC20(address(quote)), address(house));

        _pushFeeds(200e8);
    }

    // ---- actions ----

    /// @notice Fills a book for the next cross of one of the two kinds. The two
    /// sides partition the five actors rather than overlapping, and they are sized
    /// to meet, because the print counts distinct owners and its floor is five.
    function actCommitBook(uint256 seed) public {
        uint8 kind = uint8(seed & 1);
        // One book per auction. The two sides below are sized to divide evenly
        // against each other, and a second fill on top of the first breaks that,
        // which leaves a cross that cannot be built without losing more to the
        // flooring than the contract allows per fill.
        uint64 booked = lastBooked[kind];
        if (booked != 0) {
            (,, uint8 phase,,,) = house.auctionState(booked);
            if (phase == 0 || phase == PHASE_DISCLOSURE) return;
        }
        uint8 sessionBit = kind == 0 ? SessionMask.AUCTION_OPEN : SessionMask.AUCTION_CLOSE;

        uint256 buyers = 2 + (seed >> 16) % 2;
        uint256 sellers = 5 - buyers;
        // Six tenths of a token is the step, because either side can hold two or
        // three actors and the two sides have to divide evenly. A book that needs a
        // partial fill on its last entry loses up to one quote unit of token to the
        // flooring, and the contract allows one per fill.
        //
        // Three books in four are sized over the thousand dollar print floor and
        // the fourth under it, because I13 has two branches and a campaign that
        // only ever reaches the withholding one has not tested the other. Two
        // buyers at three tokens each clear twelve hundred dollars at the two
        // hundred dollar reference, which is the smallest book that always passes.
        uint256 steps = (seed >> 48) % 4 == 0 ? 1 + (seed >> 32) % 4 : 5 + (seed >> 32) % 3;
        uint256 qty = steps * 6e17;
        uint256 perSeller = (buyers * qty) / sellers;

        for (uint256 k = 0; k < buyers; ++k) {
            uint256 spend = (qty * 200) / 1e12;
            quote.mint(actors[k], spend);
            _commit(actors[k], true, spend, sessionBit);
        }
        for (uint256 k = 0; k < sellers; ++k) {
            base.mint(actors[buyers + k], perSeller);
            _commit(actors[buyers + k], false, perSeller, sessionBit);
        }
        if (committed.length > 0) lastBooked[kind] = committed[committed.length - 1].auctionId;
        _checkInvariants();
    }

    /// @notice Takes whichever step the picked auction is currently ready for.
    /// The phases still only happen in order and the clock still decides which one
    /// is legal, so this drives nothing. It exists because the first auction
    /// session sits most of a day past where echidna starts its clock, and the
    /// freeze window at the end of it is three hundred seconds wide. Spending that
    /// window on a draw for one action out of a dozen is how a campaign reaches a
    /// cross and never a print.
    function actAdvance(uint256 seed) public {
        uint64 id = _pickByPhase(PHASE_CROSSED, seed);
        if (id != 0) {
            actExecute(seed);
            return;
        }
        id = _pickByPhase(PHASE_FROZEN, seed);
        if (id != 0) {
            actCross(seed);
            return;
        }
        id = _pickByPhase(PHASE_DISCLOSURE, seed);
        if (id != 0) {
            actFreeze(seed);
            return;
        }
        actOpen(seed);
    }

    function actOpen(uint256 seed) public {
        try house.openAuction(address(base), uint8(seed & 1)) {} catch {}
        _checkInvariants();
    }

    function actFreeze(uint256 seed) public {
        uint64 id = _pickByPhase(PHASE_DISCLOSURE, seed);
        if (id == 0) return;
        _pushFeeds(200e8);
        try house.freeze(id) {
            freezes += 1;
        } catch {}
        _checkInvariants();
    }

    function actExtend(uint256 seed) public {
        uint64 id = _pickByPhase(PHASE_FROZEN, seed);
        if (id == 0) return;
        try house.extend(id) {} catch {}
        _checkInvariants();
    }

    function actCross(uint256 seed) public {
        uint64 id = _pickByPhase(PHASE_FROZEN, seed);
        if (id == 0) return;
        _pushFeeds(200e8);

        (uint256 price, uint256 matched,) = house.indicative(id);
        if (price == 0 || matched == 0) return;
        Execution[] memory e = _buildCross(id, price, matched);
        if (e.length == 0) return;

        try house.submitCross(id, price, e) {
            crossesSubmitted += 1;
        } catch {}
        _checkInvariants();
    }

    function actChallenge(uint256 seed) public {
        uint64 id = _pickByPhase(PHASE_CROSSED, seed);
        if (id == 0) return;
        (, uint256 price,,,,) = house.auctionResult(id);
        if (price == 0) return;
        uint256 better = seed & 2 == 0 ? (price * 10_050) / BPS : (price * 9950) / BPS;
        try challenger.challenge(house, id, better) {} catch {}
        _checkInvariants();
    }

    function actExecute(uint256 seed) public {
        uint64 id = _pickByPhase(PHASE_CROSSED, seed);
        if (id == 0) return;
        uint32 before = house.latestPrintDay(address(base));
        try house.executeCross(id) {
            crossesExecuted += 1;
            uint32 day = house.latestPrintDay(address(base));
            if (day != before) {
                printsPublished += 1;
                if (!knownPrintDay[day]) {
                    knownPrintDay[day] = true;
                    printDays.push(day);
                }
            }
        } catch {}
        _checkInvariants();
    }

    /// @notice From somebody who committed nothing, because I10 says anyone.
    function actAbort(uint256 seed) public {
        uint64 id = _pickLive(seed);
        if (id == 0) return;
        try stranger.abortAuction(house, id) {
            auctionsAborted += 1;
        } catch {}
        _checkInvariants();
    }

    /// @notice Also from the stranger. An auction that settled must hand back every
    /// unspent escrow to the address that put it up, on a call from anybody.
    function actRefund(uint256 seed) public {
        if (committed.length == 0) return;
        uint256 start = seed % committed.length;

        for (uint256 step = 0; step < 8 && step < committed.length; ++step) {
            Committed memory c = committed[(start + step) % committed.length];
            AuctionHouse.Commitment memory live = house.commitment(c.intentHash);
            (,, uint8 phase,,,) = house.auctionState(c.auctionId);
            bool settled = phase == PHASE_EXECUTED || phase == PHASE_ABORTED;
            bool owed = settled && live.escrowed && !live.refunded;

            try stranger.refundEscrow(house, c.intentHash) {
                if (refunded[c.intentHash]) doubleRefunds += 1;
                refunded[c.intentHash] = true;
                refundsPaid += 1;
            } catch {
                // I10. Escrow that the auction did not spend is recoverable the
                // moment the auction settles, and it is not the owner's privilege.
                if (owed) refundDenied += 1;
            }
        }
        _checkInvariants();
    }

    function actMultiplierChange(uint256 seed) public {
        base.setUiMultiplier(1e18 + (seed % 1e18));
        _checkInvariants();
    }

    function actPushFeeds(uint256 seed) public {
        int256 answer = int256(200e8);
        int256 delta = (answer * int256(seed % 500)) / 10_000;
        _pushFeeds(seed & 1 == 0 ? answer + delta : answer - delta);
        _checkInvariants();
    }

    // ---- invariants ----

    function _checkInvariants() internal {
        // I13. Nothing is printed below either floor, and the two floors are read
        // back off the contract rather than repeated here.
        for (uint256 k = 0; k < printDays.length; ++k) {
            (, uint256 volume, uint32 participants, bool published) =
                house.closingPrice(address(base), printDays[k]);
            if (!published) continue;
            if (volume < house.printMinVolume()) printBelowFloor += 1;
            if (participants < house.PRINT_MIN_PARTICIPANTS()) printBelowFloor += 1;
        }
        assert(printBelowFloor == 0);

        // I10.
        assert(refundDenied == 0);
        assert(doubleRefunds == 0);

        // The house holds everything it has not paid out. This is the one that
        // caught a bond being handed back twice.
        (uint256 quoteOwed, uint256 baseOwed) = _outstandingEscrow();
        assert(quote.balanceOf(address(house)) >= quoteOwed);
        assert(base.balanceOf(address(house)) >= baseOwed);
    }

    /// @dev What the book is still owed, counting only escrow that was actually
    /// pulled and has not been handed back or spent.
    function _outstandingEscrow() internal view returns (uint256 quoteOwed, uint256 baseOwed) {
        for (uint256 k = 0; k < committed.length; ++k) {
            AuctionHouse.Commitment memory c = house.commitment(committed[k].intentHash);
            if (!c.escrowed || c.refunded) continue;
            uint256 left = c.sellAmount - c.filledSell;
            if (c.sellToken == address(quote)) quoteOwed += left;
            else baseOwed += left;
        }
    }

    // ---- building ----

    function _commit(address who, bool buy, uint256 amount, uint8 sessionBit) internal {
        Intent memory i = Intent({
            owner: who,
            receiver: who,
            sellToken: buy ? address(quote) : address(base),
            buyToken: buy ? address(base) : address(quote),
            sellAmount: amount,
            minBuyAmount: 0,
            validAfter: 0,
            validUntil: type(uint32).max,
            flags: IntentFlags.AUCTION,
            kind: uint8(IntentKind.MOO),
            maxDevFromRefBps: 0,
            allowedSessions: sessionBit,
            batchSpan: 1,
            nonce: nextNonce++
        });

        bytes32 intentHash = this.hashOf(i);
        try house.commitAuctionIntent(i, hex"01") {
            commitsAccepted += 1;
            AuctionHouse.Commitment memory c = house.commitment(intentHash);
            committed.push(
                Committed({
                    intentHash: intentHash,
                    auctionId: c.auctionId,
                    owner: who,
                    sellToken: i.sellToken,
                    sellAmount: i.sellAmount
                })
            );
            if (!knownAuction[c.auctionId]) {
                knownAuction[c.auctionId] = true;
                auctionIds.push(c.auctionId);
            }
        } catch {}
    }

    /// @dev IntentLib hashes calldata and these are built in memory, so the hash
    /// takes one external hop to reach.
    function hashOf(Intent calldata i) external pure returns (bytes32) {
        return IntentLib.hash(i);
    }

    /// @dev Fills the demand side up to the quote value of the matched volume, then
    /// the supply side up to the token volume that actually came out of it. The
    /// contract floors every conversion in its own favour, so taking the realised
    /// token amount rather than the intended one is what keeps conservation true.
    function _buildCross(uint64 auctionId, uint256 price, uint256 matched)
        internal
        view
        returns (Execution[] memory)
    {
        uint256 n = house.bookLength(auctionId);
        uint256[] memory sellFill = new uint256[](n);
        uint256[] memory buyFill = new uint256[](n);

        uint256 quoteBudget = (matched * price) / WAD;
        uint256 tokenOut;
        for (uint256 k = 0; k < n && quoteBudget > 0; ++k) {
            AuctionHouse.Commitment memory c = house.commitment(house.bookAt(auctionId, k));
            if (!c.escrowed || c.cancelled || !c.buy) continue;
            uint256 take = c.sellAmount < quoteBudget ? c.sellAmount : quoteBudget;
            uint256 out = (take * WAD) / price;
            if (out == 0) continue;
            sellFill[k] = take;
            buyFill[k] = out;
            quoteBudget -= take;
            tokenOut += out;
        }
        if (tokenOut == 0) return new Execution[](0);

        uint256 tokenBudget = tokenOut;
        for (uint256 k = 0; k < n && tokenBudget > 0; ++k) {
            AuctionHouse.Commitment memory c = house.commitment(house.bookAt(auctionId, k));
            if (!c.escrowed || c.cancelled || c.buy) continue;
            uint256 take = c.sellAmount < tokenBudget ? c.sellAmount : tokenBudget;
            uint256 out = (take * price) / WAD;
            if (out == 0) continue;
            sellFill[k] = take;
            buyFill[k] = out;
            tokenBudget -= take;
        }
        if (tokenBudget > 0) return new Execution[](0);

        uint256 count;
        for (uint256 k = 0; k < n; ++k) {
            if (sellFill[k] > 0) count += 1;
        }

        Execution[] memory e = new Execution[](count);
        uint256 at;
        for (uint256 k = 0; k < n; ++k) {
            if (sellFill[k] == 0) continue;
            e[at++] = Execution({intentIndex: k, executedSell: sellFill[k], executedBuy: buyFill[k]});
        }
        return e;
    }

    /// @dev The first known auction sitting in the phase this action is for,
    /// starting the scan at a seed offset so the choice is not always the oldest.
    /// Picking uniformly out of every auction ever opened was what kept the
    /// campaign from ever reaching a cross. By the time one auction reached the
    /// freeze there were several days of them on the list, and a solver that
    /// watches one auction at random is not a solver.
    function _pickByPhase(uint8 wanted, uint256 seed) internal view returns (uint64) {
        uint256 n = auctionIds.length;
        if (n == 0) return 0;
        uint256 start = seed % n;
        for (uint256 k = 0; k < n; ++k) {
            uint64 id = auctionIds[(start + k) % n];
            (,, uint8 phase,,,) = house.auctionState(id);
            if (phase == wanted) return id;
        }
        return 0;
    }

    /// @dev Any auction that has not settled yet, which is what abort is for.
    function _pickLive(uint256 seed) internal view returns (uint64) {
        uint256 n = auctionIds.length;
        if (n == 0) return 0;
        uint256 start = seed % n;
        for (uint256 k = 0; k < n; ++k) {
            uint64 id = auctionIds[(start + k) % n];
            (,, uint8 phase,,,) = house.auctionState(id);
            if (phase == PHASE_DISCLOSURE || phase == PHASE_FROZEN || phase == PHASE_CROSSED) return id;
        }
        return 0;
    }

    function _pushFeeds(int256 basePrice) internal {
        quoteFeed.push(1e8, block.timestamp);
        baseFeed.push(basePrice, block.timestamp);
    }
}
