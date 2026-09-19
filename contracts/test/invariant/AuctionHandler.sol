// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../../src/AuctionHouse.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {IntentLib} from "../../src/libraries/IntentLib.sol";
import {Permit2Witness} from "../../src/libraries/Permit2Witness.sol";
import {Execution, Intent, IntentFlags, IntentKind, Session, SessionMask} from "../../src/types/Types.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";

/// @notice Runs whole auctions, because the phases only mean anything in order and
/// a handler that could call freeze without a book would spend its whole budget
/// bouncing off WrongPhase. The randomness is in the book, the clearing price, and
/// which of the four endings the auction reaches. Executed, aborted, challenged
/// out, or left to time out.
contract AuctionHandler is Test {
    struct Committed {
        bytes32 intentHash;
        uint64 auctionId;
        address owner;
        address sellToken;
        uint256 sellAmount;
    }

    uint256 internal constant WAD = 1e18;
    uint16 internal constant BPS = 10_000;

    AuctionHouse public immutable house;
    SessionManager public immutable sessions;
    PriceOracle public immutable oracle;
    MockPermit2 public immutable permit2;
    MockERC20 public immutable quote;
    MockERC20 public immutable base;
    MockAggregator public immutable quoteFeed;
    MockAggregator public immutable baseFeed;
    address public immutable solver;
    address public immutable challenger;

    uint256[5] internal keys;
    address[5] public actors;

    Committed[] internal committed;
    uint64[] internal auctionIds;
    mapping(uint64 => bool) internal knownAuction;
    mapping(bytes32 => bool) public refundedOnce;

    uint256 public nextNonce = 1;
    uint256 public crossesExecuted;
    uint256 public auctionsAborted;
    uint256 public challengesHeard;
    uint256 public refundsPaid;
    uint256 public doubleRefunds;
    uint256 public printsPublished;

    constructor(
        AuctionHouse house_,
        SessionManager sessions_,
        PriceOracle oracle_,
        MockPermit2 permit2_,
        MockERC20 quote_,
        MockERC20 base_,
        MockAggregator quoteFeed_,
        MockAggregator baseFeed_,
        address solver_,
        address challenger_,
        uint256[5] memory keys_
    ) {
        house = house_;
        sessions = sessions_;
        oracle = oracle_;
        permit2 = permit2_;
        quote = quote_;
        base = base_;
        quoteFeed = quoteFeed_;
        baseFeed = baseFeed_;
        solver = solver_;
        challenger = challenger_;
        keys = keys_;
        for (uint256 k = 0; k < 5; ++k) {
            actors[k] = vm.addr(keys_[k]);
        }
    }

    function committedCount() external view returns (uint256) {
        return committed.length;
    }

    function committedAt(uint256 index) external view returns (Committed memory) {
        return committed[index];
    }

    function auctionCount() external view returns (uint256) {
        return auctionIds.length;
    }

    function auctionAt(uint256 index) external view returns (uint64) {
        return auctionIds[index];
    }

    /// @notice Builds a book, freezes it, crosses it and executes it. The ending is
    /// chosen by the seed, so the abort and challenge paths get the same share of
    /// the budget as the happy one.
    function actRunAuction(uint256 seed) external {
        uint8 kind = uint8(seed & 1);
        if (!_reachAuctionSession(kind)) return;

        uint64 auctionId = _fillBook(seed, kind);
        if (auctionId == 0) return;

        try house.openAuction(base_token(), kind) {} catch {}

        uint8 ending = uint8(bound(seed >> 8, 0, 9));
        if (ending == 0) {
            _abortWithoutCrossing(auctionId);
            return;
        }

        if (!_freeze(auctionId)) return;
        if (!_cross(auctionId)) return;

        if (ending == 1) {
            _challenge(auctionId, seed);
            return;
        }
        _execute(auctionId);
    }

    /// @notice Refunds whatever is refundable, from a caller who committed nothing.
    /// I10 says anyone, so the handler asks as a stranger rather than as the owner.
    function actRefund(uint256 seed) external {
        if (committed.length == 0) return;
        uint256 start = bound(seed, 0, committed.length - 1);
        for (uint256 step = 0; step < 8 && step < committed.length; ++step) {
            Committed memory c = committed[(start + step) % committed.length];
            vm.prank(address(0x57A46E));
            try house.refundEscrow(c.intentHash) {
                if (refundedOnce[c.intentHash]) doubleRefunds += 1;
                refundedOnce[c.intentHash] = true;
                refundsPaid += 1;
            } catch {}
        }
    }

    function actAbort(uint256 seed) external {
        if (auctionIds.length == 0) return;
        uint64 auctionId = auctionIds[bound(seed, 0, auctionIds.length - 1)];
        vm.prank(address(0x57A46E));
        try house.abortAuction(auctionId) {
            auctionsAborted += 1;
        } catch {}
    }

    function actMultiplierChange(uint256 seed) external {
        base.setUiMultiplier(bound(seed, 1e18, 2e18));
    }

    function actWarpForward(uint256 seed) external {
        vm.warp(vm.getBlockTimestamp() + bound(seed, 60, 2 days));
        _pushFeeds(200e8);
    }

    function base_token() public view returns (address) {
        return address(base);
    }

    /// @dev Walks the clock to the next auction session of the right kind. Both are
    /// half an hour long and land once a trading day, so anything that misses one
    /// waits for tomorrow rather than pretending.
    function _reachAuctionSession(uint8 kind) internal returns (bool) {
        Session wanted = kind == 0 ? Session.AUCTION_OPEN : Session.AUCTION_CLOSE;
        uint64 cursor = uint64(vm.getBlockTimestamp());
        if (sessions.sessionAt(cursor) == wanted) {
            _pushFeeds(200e8);
            return true;
        }

        for (uint256 step = 0; step < 24; ++step) {
            uint64 next = sessions.nextTransition(cursor);
            if (next == 0 || next <= cursor) return false;
            cursor = next;
            if (sessions.sessionAt(cursor) == wanted) {
                vm.warp(cursor + 60);
                _pushFeeds(200e8);
                return true;
            }
        }
        return false;
    }

    function _fillBook(uint256 seed, uint8 kind) internal returns (uint64 auctionId) {
        uint8 sessionBit = kind == 0 ? SessionMask.AUCTION_OPEN : SessionMask.AUCTION_CLOSE;
        // The two sides partition the five actors rather than overlapping, because
        // the print counts distinct owners and its floor is five of them.
        uint256 buyers = bound(seed >> 16, 2, 3);
        uint256 sellers = 5 - buyers;
        // Six tenths of a token is the step, because either side can hold two or
        // three actors and the two sides have to divide evenly. A book that needs a
        // partial fill on the last entry loses up to one quote unit of token to the
        // flooring, which at six against eighteen decimals is five billion token
        // units, and the contract allows one per fill.
        uint256 qty = bound(seed >> 32, 1, 7) * 6e17;

        // The two sides are sized to meet, so every actor gets a fill and the
        // participant count can reach the print floor of five. A book where one
        // side is uniformly larger would clear with four every time, and the print
        // invariant would then be about a print that never happened.
        uint256 demand = buyers * qty;
        uint256 perSeller = demand / sellers;

        for (uint256 k = 0; k < buyers; ++k) {
            address who = actors[k];
            uint256 spend = (qty * 200) / 1e12;
            quote.mint(who, spend);
            _commit(who, true, spend, sessionBit, seed);
        }
        for (uint256 k = 0; k < sellers; ++k) {
            address who = actors[buyers + k];
            base.mint(who, perSeller);
            _commit(who, false, perSeller, sessionBit, seed);
        }

        (uint32 day,) = _nextCrossOf(kind);
        if (day == 0) return 0;
        auctionId = house.auctionIdOf(address(base), day, kind);
        if (auctionId != 0 && !knownAuction[auctionId]) {
            knownAuction[auctionId] = true;
            auctionIds.push(auctionId);
        }
    }

    function _commit(address who, bool buy, uint256 amount, uint8 sessionBit, uint256 seed) internal {
        vm.prank(who);
        IERC20(buy ? address(quote) : address(base)).approve(address(permit2), type(uint256).max);

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
        bytes memory sig = _sign(_keyOf(who), i, intentHash);

        try house.commitAuctionIntent(i, sig) {
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

    function _freeze(uint64 auctionId) internal returns (bool) {
        (uint64 freezeAt, uint64 crossAt,) = house.auctionTiming(auctionId);
        if (freezeAt == 0 || crossAt <= freezeAt) return false;
        vm.warp(freezeAt + 1);
        _pushFeeds(200e8);
        try house.freeze(auctionId) {
            return true;
        } catch {
            return false;
        }
    }

    function _cross(uint64 auctionId) internal returns (bool) {
        (, uint64 crossAt, uint64 referenceAt) = house.auctionTiming(auctionId);
        if (referenceAt == 0) return false;
        vm.warp(referenceAt + 1);
        _pushFeeds(200e8);
        if (crossAt == 0) return false;

        (uint256 price, uint256 matched,) = house.indicative(auctionId);
        if (price == 0 || matched == 0) return false;

        Execution[] memory e = _buildCross(auctionId, price, matched);
        if (e.length == 0) return false;

        vm.prank(solver);
        try house.submitCross(auctionId, price, e) {
            return true;
        } catch {
            return false;
        }
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

    function _challenge(uint64 auctionId, uint256 seed) internal {
        (, uint256 price,,,,) = house.auctionResult(auctionId);
        if (price == 0) return;
        uint256 better = seed & 2 == 0 ? (price * 10_050) / BPS : (price * 9950) / BPS;
        vm.prank(challenger);
        try house.challenge(auctionId, better) {
            challengesHeard += 1;
        } catch {}
    }

    function _execute(uint64 auctionId) internal {
        vm.warp(vm.getBlockTimestamp() + house.CHALLENGE_WINDOW() + 1);
        _pushFeeds(200e8);
        uint32 dayBefore = house.latestPrintDay(address(base));
        try house.executeCross(auctionId) {
            crossesExecuted += 1;
            if (house.latestPrintDay(address(base)) != dayBefore) printsPublished += 1;
        } catch {}
    }

    function _abortWithoutCrossing(uint64 auctionId) internal {
        (, uint64 crossAt, uint64 referenceAt) = house.auctionTiming(auctionId);
        if (referenceAt == 0 || crossAt == 0) return;
        vm.warp(referenceAt + house.EXTENSION_PERIOD() * (uint64(house.MAX_EXTENSIONS()) + 1) + 1);
        _pushFeeds(200e8);
        vm.prank(address(0x57A46E));
        try house.abortAuction(auctionId) {
            auctionsAborted += 1;
        } catch {}
    }

    function _nextCrossOf(uint8 kind) internal view returns (uint32 day, uint64 crossAt) {
        Session wanted = kind == 0 ? Session.AUCTION_OPEN : Session.AUCTION_CLOSE;
        uint64 cursor = uint64(vm.getBlockTimestamp());
        for (uint256 step = 0; step < 48; ++step) {
            if (sessions.sessionAt(cursor) == wanted) {
                crossAt = sessions.nextTransition(cursor);
                if (crossAt == 0) return (0, 0);
                return (_ymd(uint32(crossAt / 1 days)), crossAt);
            }
            uint64 next = sessions.nextTransition(cursor);
            if (next == 0 || next <= cursor) return (0, 0);
            cursor = next;
        }
        return (0, 0);
    }

    function _ymd(uint32 dayIndex) internal view returns (uint32) {
        return sessions.easternDay(uint64(dayIndex) * 1 days + 12 hours);
    }

    function _pushFeeds(int256 basePrice) internal {
        quoteFeed.push(1e8, vm.getBlockTimestamp());
        baseFeed.push(basePrice, vm.getBlockTimestamp());
    }

    function _keyOf(address who) internal view returns (uint256) {
        for (uint256 k = 0; k < 5; ++k) {
            if (actors[k] == who) return keys[k];
        }
        return keys[0];
    }

    function _sign(uint256 key, Intent memory i, bytes32 intentHash) internal view returns (bytes memory) {
        bytes32 digest = Permit2Witness.digest(
            permit2.DOMAIN_SEPARATOR(),
            house.permitTypeHash(),
            i.sellToken,
            i.sellAmount,
            address(house),
            i.nonce,
            i.validUntil,
            intentHash
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function hashOf(Intent calldata i) external pure returns (bytes32) {
        return IntentLib.hash(i);
    }
}
