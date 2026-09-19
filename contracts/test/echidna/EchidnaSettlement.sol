// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ClearingVerifier} from "../../src/ClearingVerifier.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {Settlement} from "../../src/Settlement.sol";
import {IClearingVerifier} from "../../src/interfaces/IClearingVerifier.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../../src/interfaces/ISolverRegistry.sol";
import {Execution, Intent, Session, Solution, VenueCall} from "../../src/types/Types.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSolverRegistry} from "../mocks/MockSolverRegistry.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";

/// @dev An intent owner has to have approved Permit2 itself, and echidna cannot
/// impersonate an address to do it. So the owners are contracts that approve on
/// the way in, which is also what a real account abstraction wallet does.
contract EchidnaActor {
    constructor(address permit2, address quote, address base) {
        IERC20(quote).approve(permit2, type(uint256).max);
        IERC20(base).approve(permit2, type(uint256).max);
    }
}

/// @notice The settlement core under echidna, per rencana-uji.md section 1. It
/// drives the same protocol the foundry campaign drives and checks the same
/// invariants, but it gets there without a single cheatcode, which changes the
/// design in three ways worth stating.
///
/// There is no warp. A batch is chosen to fit the clock echidna has moved to
/// rather than the clock being moved to fit a batch, so submission only lands when
/// the current second is within the solution window of an aligned mark. The rest
/// of the calls return early, and that is the cost of running without cheatcodes.
///
/// There is no prank. Intent owners are contracts that approve Permit2 in their
/// own constructors.
///
/// There is no fixture read. The session engine is loaded with a two entry DST
/// table that brackets the whole run, so the offset is constant and every weekday
/// is an ordinary trading day. The calendar itself is proved elsewhere, against
/// the real fixture, sixteen years of it. What this target needs from the session
/// engine is a clock that moves, not a clock that is right about Good Friday.
///
/// Every invariant is checked after every action, which is what section 2 asks for.
contract EchidnaSettlement {
    uint256 internal constant WAD = 1e18;
    uint16 internal constant BPS = 10_000;

    /// Inside the three basis points the verifier allows. At or above three is a
    /// dishonest action rather than an honest one.
    uint16 internal constant HONEST_WEDGE_BPS = 2;

    uint16 internal constant FEE_CAP_SHARE_BPS = 2000;
    uint16 internal constant FEE_CAP_NOTIONAL_BPS = 3;

    SessionManager internal sessions;
    PriceOracle internal oracle;
    ClearingVerifier internal verifier;
    Settlement internal settlement;
    MockPermit2 internal permit2;
    MockSolverRegistry internal registry;
    MockSwapAdapter internal venue;

    MockERC20 internal quote;
    MockERC20 internal base;
    MockAggregator internal quoteFeed;
    MockAggregator internal baseFeed;

    address internal treasury = address(0x7EA);
    address[2] internal actors;

    uint64 internal pendingBatch;
    uint256 internal pendingSeed;
    bool internal pendingWithVenue;

    mapping(address => uint256) internal nextNonce;
    mapping(bytes32 => bool) internal nonceSettled;

    uint256 public settledCount;
    uint256 public submittedCount;
    uint256 public dishonestAccepted;
    uint256 public duplicateNonces;
    uint256 public feeAboveCap;
    uint256 public movedByGovernor;
    uint256 public brokenAtomicity;
    uint256 internal cumulativeFeeCap;

    constructor() {
        quote = new MockERC20("Global Dollar", "USDG", 6);
        base = new MockERC20("Nvidia", "NVDA", 18);
        quoteFeed = new MockAggregator(8, "USDG / USD");
        baseFeed = new MockAggregator(8, "RHNVDA / USD");
        venue = new MockSwapAdapter();
        permit2 = new MockPermit2();
        registry = new MockSolverRegistry();
        verifier = new ClearingVerifier();

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

        settlement = new Settlement(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            IClearingVerifier(address(verifier)),
            ISolverRegistry(address(registry)),
            ISignatureTransfer(address(permit2)),
            treasury,
            address(this),
            address(this)
        );
        settlement.setTokenAllowed(address(quote), true);
        settlement.setTokenAllowed(address(base), true);
        settlement.setAdapterAllowed(address(venue), true);
        registry.setActive(address(this), true);

        // The venue swaps raw units, so the rate carries the decimal gap between a
        // six decimal quote and an eighteen decimal base. Two hundred in gives one.
        venue.setRate(address(quote), address(base), 5e27);
        venue.setRate(address(base), address(quote), 200e6);

        actors[0] = address(new EchidnaActor(address(permit2), address(quote), address(base)));
        actors[1] = address(new EchidnaActor(address(permit2), address(quote), address(base)));

        _refreshFeeds(200e8);
    }

    // ---- actions ----

    /// @notice Submits an honest pair that nets against itself, or one that has to
    /// route half of itself through the venue.
    function actSubmit(uint256 seed) public {
        if (pendingBatch != 0) return;
        bool withVenue = seed & 1 == 0;
        (Solution memory s, bool ok) = _build(seed, 0, withVenue);
        if (!ok) return;

        try settlement.submitSolution(s) {
            submittedCount += 1;
            pendingBatch = s.batchId;
            pendingSeed = seed;
            pendingWithVenue = withVenue;
        } catch {}
        _checkInvariants();
    }

    /// @notice Finalizes whatever is pending, once echidna has moved the clock past
    /// the solving window on its own.
    function actFinalize() public {
        if (pendingBatch == 0) return;
        (Solution memory s, bool ok) = _rebuild(pendingSeed, pendingBatch, 0, pendingWithVenue);
        // An oracle round between the two calls moves the prices, and the solution
        // is matched against a hash taken at submission. A batch that can no longer
        // be rebuilt is dropped rather than left pending, because a pending batch
        // that never clears would stop the campaign submitting anything else.
        (bytes32 wanted,,) = settlement.bestSolution(pendingBatch);
        if (!ok || keccak256(abi.encode(s)) != wanted) {
            pendingBatch = 0;
            return;
        }

        uint256 quoteBefore = quote.balanceOf(actors[0]) + quote.balanceOf(actors[1]);
        uint256 baseBefore = base.balanceOf(actors[0]) + base.balanceOf(actors[1]);

        try settlement.finalize(pendingBatch, s) {
            settledCount += 1;
            _record(s);
            pendingBatch = 0;
        } catch {
            // I5. A finalize that reverted moved nothing, so the two sides of the
            // book are exactly where they were before the call.
            if (quote.balanceOf(actors[0]) + quote.balanceOf(actors[1]) != quoteBefore) {
                brokenAtomicity += 1;
            }
            if (base.balanceOf(actors[0]) + base.balanceOf(actors[1]) != baseBefore) {
                brokenAtomicity += 1;
            }
            pendingBatch = 0;
        }
        _checkInvariants();
    }

    /// @notice A solution that breaks exactly one rule. None of these may settle.
    function actSubmitDishonest(uint256 seed) public {
        if (pendingBatch != 0) return;
        uint8 kind = uint8(_bound(seed, 1, 6));
        (Solution memory s, bool ok) = _build(seed >> 8, kind, false);
        if (!ok) return;

        try settlement.submitSolution(s) {
            // A dishonest solution that got past verification still has to get past
            // finalize before it has taken anything, so the counter moves there.
            pendingBatch = s.batchId;
            pendingSeed = seed >> 8;
            pendingWithVenue = false;
            try settlement.finalize(s.batchId, s) {
                dishonestAccepted += 1;
                pendingBatch = 0;
            } catch {
                pendingBatch = 0;
            }
        } catch {}
        _checkInvariants();
    }

    /// @notice Rebuilds a batch on a nonce that already settled. Permit2 owns the
    /// bitmap, so this asks whether the settlement path can talk it out of refusing.
    function actReuseNonce(uint256 seed) public {
        if (pendingBatch != 0) return;
        (Solution memory s, bool ok) = _build(seed, 0, false);
        if (!ok) return;
        if (nextNonce[s.intents[0].owner] == 0) return;
        s.intents[0].nonce = nextNonce[s.intents[0].owner] - 1;
        s.claimedSavings = _savings(s);

        try settlement.submitSolution(s) {
            try settlement.finalize(s.batchId, s) {
                _record(s);
            } catch {}
        } catch {}
        _checkInvariants();
    }

    /// @notice Pushes a feed round, sometimes far enough off the last one to take
    /// the token outside the price band and make every solution on it fail.
    function actOracleUpdate(uint256 seed) public {
        uint256 driftBps = _bound(seed, 0, 900);
        int256 answer = int256(200e8);
        int256 delta = (answer * int256(driftBps)) / int256(uint256(BPS));
        _refreshFeeds(seed & 1 == 0 ? answer + delta : answer - delta);
        _checkInvariants();
    }

    /// @notice Four allowlist tokens have already moved off 1e18 on mainnet and
    /// three of those moves landed inside OPEN, so a batch has to meet one.
    function actMultiplierChange(uint256 seed) public {
        base.setUiMultiplier(_bound(seed, 1e18, 2e18));
        _checkInvariants();
    }

    /// @notice I11. Everything the governor is allowed to do, done at once. None of
    /// it may move a token belonging to anybody.
    function actGovernorPokes(uint256 seed) public {
        uint256 q0 = quote.balanceOf(actors[0]) + quote.balanceOf(actors[1]);
        uint256 b0 = base.balanceOf(actors[0]) + base.balanceOf(actors[1]);

        settlement.setExposureCaps(
            _bound(seed, 1e18, 10_000e18),
            _bound(seed >> 64, 1e18, 100_000e18),
            _bound(seed >> 128, 1e18, 400_000e18)
        );
        settlement.setTokenAllowed(address(base), seed & 1 == 0);
        settlement.setAdapterAllowed(address(venue), seed & 2 == 0);
        sessions.setProtective(address(base), bytes32("echidna"));
        settlement.setTokenAllowed(address(base), true);
        settlement.setAdapterAllowed(address(venue), true);

        if (quote.balanceOf(actors[0]) + quote.balanceOf(actors[1]) != q0) movedByGovernor += 1;
        if (base.balanceOf(actors[0]) + base.balanceOf(actors[1]) != b0) movedByGovernor += 1;
        _checkInvariants();
    }

    /// @notice Clears the protective flag the governor may have raised, which takes
    /// three healthy observations rather than one.
    function actReportHealthy() public {
        try sessions.reportHealthy(address(base)) {} catch {}
        _checkInvariants();
    }

    // ---- invariants ----

    function _checkInvariants() internal view {
        // I3 and I9. The core withholds the wedge and hands all of it out in the
        // same call, so between transactions it holds nothing of anybody's.
        assert(quote.balanceOf(address(settlement)) == 0);
        assert(base.balanceOf(address(settlement)) == 0);

        // I8, and every validity rule the verifier carries.
        assert(dishonestAccepted == 0);

        // I4.
        assert(duplicateNonces == 0);

        // I6.
        assert(feeAboveCap == 0);

        // I11.
        assert(movedByGovernor == 0);

        // I5.
        assert(brokenAtomicity == 0);
    }

    // ---- building ----

    function _build(uint256 seed, uint8 corruption, bool withVenue)
        internal
        returns (Solution memory s, bool ok)
    {
        uint64 batchId = _batchInWindow();
        if (batchId == 0) return (s, false);
        (s, ok) = _rebuild(seed, batchId, corruption, withVenue);
        if (!ok) return (s, false);

        // Funding happens here rather than inside the rebuild, because the rebuild
        // runs again at finalize and has to be free of side effects by then.
        quote.mint(s.intents[0].owner, s.executions[0].executedSell);
        base.mint(s.intents[1].owner, s.executions[1].executedSell);
    }

    /// @dev Deterministic in its arguments, because finalize matches the solution
    /// against a hash taken at submission and the two calls are different
    /// transactions. Nothing read here may move between them.
    function _rebuild(uint256 seed, uint64 batchId, uint8 corruption, bool withVenue)
        internal
        view
        returns (Solution memory s, bool ok)
    {
        (uint256 quoteRef,, bool quoteHealthy) = oracle.refPrice(address(quote));
        (uint256 baseRef,, bool baseHealthy) = oracle.refPrice(address(base));
        if (!quoteHealthy || !baseHealthy || quoteRef == 0 || baseRef == 0) return (s, false);

        uint256 qty = _bound(seed >> 32, 10, 200) * 1e15;
        uint256 quoteAmount = (qty * 200) / 1e12;
        uint256 buyQty = withVenue ? qty * 2 : qty;
        uint256 buySpend = withVenue ? quoteAmount * 2 : quoteAmount;
        uint256 wedge = (buyQty * (corruption == 4 ? 6 : HONEST_WEDGE_BPS)) / BPS;

        address buyer = actors[0];
        address seller = actors[1];

        s.batchId = batchId;
        s.solver = address(this);

        s.intents = new Intent[](2);
        s.intents[0] =
            _intent(buyer, address(quote), address(base), buySpend, (buyQty * 99) / 100, nextNonce[buyer]);
        s.intents[1] =
            _intent(seller, address(base), address(quote), qty, (quoteAmount * 99) / 100, nextNonce[seller]);
        s.signatures = new bytes[](2);

        s.tokens = new address[](2);
        s.tokens[0] = address(quote);
        s.tokens[1] = address(base);
        s.prices = new uint256[](2);
        s.prices[0] = (quoteRef * WAD) / (10 ** quote.decimals());
        s.prices[1] = (baseRef * WAD) / (10 ** base.decimals());
        if (corruption == 2) s.prices[1] = (s.prices[1] * 12_000) / BPS;

        uint256 buyerGets = buyQty - wedge;
        if (corruption == 1) buyerGets = (buyQty * 90) / 100;
        if (corruption == 3) buyerGets = buyQty + wedge;

        s.executions = new Execution[](2);
        s.executions[0] = Execution({intentIndex: 0, executedSell: buySpend, executedBuy: buyerGets});
        s.executions[1] = Execution({intentIndex: 1, executedSell: qty, executedBuy: quoteAmount});

        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = (buyQty * 99) / 100;
        s.baselineQuotes[1] = (quoteAmount * 99) / 100;
        if (corruption == 5) s.baselineQuotes[0] = buyQty;

        if (withVenue) {
            s.venueCalls = new VenueCall[](1);
            s.venueCalls[0] = VenueCall({
                adapter: address(venue),
                tokenIn: address(quote),
                tokenOut: address(base),
                amountIn: quoteAmount,
                minOut: qty
            });
        } else {
            s.venueCalls = new VenueCall[](0);
        }

        s.claimedSavings = _savings(s);
        if (corruption == 6) s.claimedSavings += 1e18;
        ok = true;
    }

    /// @dev The last aligned mark that the current second is still inside the
    /// solution window of. There is no warp here, so a clock that landed further
    /// than the window from a mark simply has no batch to work on.
    function _batchInWindow() internal view returns (uint64) {
        uint64 now_ = uint64(block.timestamp);
        Session session = sessions.sessionAt(now_);
        uint32 duration = sessions.batchDuration(session);
        if (duration == 0) return 0;

        uint64 batchId = (now_ / duration) * duration;
        if (batchId <= duration) return 0;
        if (batchId == now_) batchId -= duration;
        if (now_ - batchId > settlement.SOLUTION_WINDOW()) return 0;
        if (sessions.sessionAt(batchId) != session) return 0;
        if (sessions.inGuardBand(batchId)) return 0;
        if (settlement.finalized(batchId)) return 0;
        return batchId;
    }

    function _record(Solution memory s) internal {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            Intent memory i = s.intents[s.executions[k].intentIndex];
            bytes32 key = keccak256(abi.encode(i.owner, i.nonce));
            if (nonceSettled[key]) duplicateNonces += 1;
            nonceSettled[key] = true;
            if (i.nonce >= nextNonce[i.owner]) nextNonce[i.owner] = i.nonce + 1;
        }

        // I6. Fees are the only way the solver ever receives a token here, so what
        // it is holding is the running total of what it has taken, and the ceiling
        // it is measured against is the running total of the per batch ceilings.
        uint256 byShare = ((s.claimedSavings + _withheldUsd(s)) * FEE_CAP_SHARE_BPS) / BPS;
        uint256 byNotional = (_notional(s) * FEE_CAP_NOTIONAL_BPS) / BPS;
        cumulativeFeeCap += byShare < byNotional ? byShare : byNotional;

        uint256 taken = (quote.balanceOf(address(this)) * s.prices[0]) / WAD
            + (base.balanceOf(address(this)) * s.prices[1]) / WAD;
        if (taken > cumulativeFeeCap) feeAboveCap += 1;
    }

    function _withheldUsd(Solution memory s) internal pure returns (uint256 total) {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            Execution memory e = s.executions[k];
            Intent memory i = s.intents[e.intentIndex];
            uint256 sellPrice = i.sellToken == s.tokens[0] ? s.prices[0] : s.prices[1];
            uint256 buyPrice = i.buyToken == s.tokens[0] ? s.prices[0] : s.prices[1];
            uint256 valueIn = (e.executedSell * sellPrice) / WAD;
            uint256 valueOut = (e.executedBuy * buyPrice) / WAD;
            if (valueIn > valueOut) total += valueIn - valueOut;
        }
    }

    function _notional(Solution memory s) internal pure returns (uint256 total) {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            Execution memory e = s.executions[k];
            Intent memory i = s.intents[e.intentIndex];
            uint256 price = i.sellToken == s.tokens[0] ? s.prices[0] : s.prices[1];
            total += (e.executedSell * price) / WAD;
        }
    }

    function _savings(Solution memory s) internal pure returns (uint256 total) {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            Execution memory e = s.executions[k];
            if (e.executedBuy <= s.baselineQuotes[k]) continue;
            uint256 price = s.intents[e.intentIndex].buyToken == s.tokens[0] ? s.prices[0] : s.prices[1];
            total += ((e.executedBuy - s.baselineQuotes[k]) * price) / WAD;
        }
    }

    function _intent(
        address owner,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 minBuy,
        uint256 nonce
    ) internal pure returns (Intent memory i) {
        i = Intent({
            owner: owner,
            receiver: owner,
            sellToken: sellToken,
            buyToken: buyToken,
            sellAmount: sellAmount,
            minBuyAmount: minBuy,
            validAfter: 0,
            validUntil: type(uint32).max,
            flags: 0,
            kind: 0,
            maxDevFromRefBps: 0,
            allowedSessions: type(uint8).max,
            batchSpan: 1,
            nonce: nonce
        });
    }

    function _refreshFeeds(int256 baseAnswer) internal {
        quoteFeed.push(1e8, block.timestamp);
        baseFeed.push(baseAnswer, block.timestamp);
    }

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi <= lo) return lo;
        return lo + (x % (hi - lo + 1));
    }
}
