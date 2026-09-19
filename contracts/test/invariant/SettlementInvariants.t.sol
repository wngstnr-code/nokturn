// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingVerifier} from "../../src/ClearingVerifier.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {Settlement} from "../../src/Settlement.sol";
import {IClearingVerifier} from "../../src/interfaces/IClearingVerifier.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../../src/interfaces/ISolverRegistry.sol";
import {CalendarFixture} from "../../script/Calendar.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSolverRegistry} from "../mocks/MockSolverRegistry.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";
import {SettlementHandler} from "./SettlementHandler.sol";

/// @notice Invariants I1 to I9 and I11 from rencana-uji.md section 1, over the
/// settlement core. The handler is what makes these worth anything, because an
/// invariant over a state machine that only ever took the happy path proves that
/// the happy path is happy.
contract SettlementInvariants is Test {
    uint256 internal constant WAD = 1e18;
    uint16 internal constant BPS = 10_000;
    uint16 internal constant FEE_CAP_SHARE_BPS = 2000;
    uint16 internal constant FEE_CAP_NOTIONAL_BPS = 3;

    SessionManager sessions;
    PriceOracle oracle;
    ClearingVerifier verifier;
    Settlement settlement;
    MockPermit2 permit2;
    MockSolverRegistry registry;
    MockSwapAdapter venue;
    MockSwapAdapter twapSource;

    MockERC20 usdg;
    MockERC20 nvda;
    MockAggregator usdgFeed;
    MockAggregator nvdaFeed;

    SettlementHandler handler;

    address governor = address(0x60174E);
    address treasury = address(0x7EA);
    address guardian = address(0x6A4D1A4);
    address solver = address(0x501E);

    /// Wednesday 11 March 2026, ten minutes after the bell.
    uint64 constant DAY_OPEN = 1_773_235_800;

    function setUp() public {
        sessions = new SessionManager(governor);
        vm.startPrank(governor);
        sessions.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(sessions, CalendarFixture.loadDays());
        vm.stopPrank();

        usdg = new MockERC20("Global Dollar", "USDG", 6);
        nvda = new MockERC20("Nvidia", "NVDA", 18);
        usdgFeed = new MockAggregator(8, "USDG / USD");
        nvdaFeed = new MockAggregator(8, "RHNVDA / USD");

        venue = new MockSwapAdapter();
        // The swap rate carries the decimal gap, so 200 USDG buys one NVDA.
        venue.setRate(address(usdg), address(nvda), 5e27);
        venue.setRate(address(nvda), address(usdg), 200e6);

        // The oracle reads a TWAP as a dollar price per whole token, which is a
        // different shape from a swap rate. Separating the two is what lets a
        // weekend batch reach the settlement path at all.
        twapSource = new MockSwapAdapter();
        twapSource.setRate(address(usdg), address(nvda), 1e18);
        twapSource.setRate(address(nvda), address(usdg), 200e18);

        oracle = new PriceOracle(ISessionManager(address(sessions)), governor);
        vm.startPrank(governor);
        oracle.setFeed(address(usdg), address(usdgFeed), 6000, 20_000);
        oracle.setFeed(address(nvda), address(nvdaFeed), 6000, 20_000);
        oracle.setTwapSource(address(usdg), address(twapSource), address(nvda), 1800);
        oracle.setTwapSource(address(nvda), address(twapSource), address(usdg), 1800);
        vm.stopPrank();

        verifier = new ClearingVerifier();
        registry = new MockSolverRegistry();
        registry.setActive(solver, true);
        permit2 = new MockPermit2();

        settlement = new Settlement(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            IClearingVerifier(address(verifier)),
            ISolverRegistry(address(registry)),
            ISignatureTransfer(address(permit2)),
            treasury,
            governor,
            guardian
        );

        vm.startPrank(governor);
        settlement.setTokenAllowed(address(usdg), true);
        settlement.setTokenAllowed(address(nvda), true);
        settlement.setAdapterAllowed(address(venue), true);
        // A baseline adapter that quotes zero, so the floor never binds. The handler
        // invents a fresh price on every action, so any fixed rate would refuse some
        // honest solutions and the suite would be measuring the floor rather than
        // conservation. The floor has its own tests in Settlement.t.sol.
        MockSwapAdapter noFloor = new MockSwapAdapter();
        settlement.setAdapterAllowed(address(noFloor), true);
        settlement.setBaselineAdapter(address(noFloor));
        vm.stopPrank();

        vm.warp(DAY_OPEN + 600);
        usdgFeed.push(1e8, block.timestamp);
        nvdaFeed.push(200e8, block.timestamp);

        handler = new SettlementHandler(
            settlement,
            sessions,
            oracle,
            permit2,
            venue,
            usdg,
            nvda,
            usdgFeed,
            nvdaFeed,
            solver,
            governor,
            treasury
        );

        targetContract(address(handler));
    }

    /// I1. The limit as the contract states it, recomputed from what settled.
    function invariant_noFillEverBreaksItsOwnLimit() public view {
        uint256 n = handler.fillCount();
        for (uint256 k = 0; k < n; ++k) {
            SettlementHandler.Fill memory f = handler.fillAt(k);
            assertGe(
                f.executedBuy * f.sellAmount, f.minBuyAmount * f.executedSell, "limit violated after the fact"
            );
        }
    }

    /// I2. Every fill in a batch settles at that batch's token prices, and the only
    /// gap allowed is the fee wedge, which is the same three basis points the
    /// protocol publishes as its notional cap.
    function invariant_everyFillSettlesAtTheBatchPrice() public view {
        uint256 n = handler.fillCount();
        for (uint256 k = 0; k < n; ++k) {
            SettlementHandler.Fill memory f = handler.fillAt(k);
            uint256 valueIn = f.executedSell * f.sellPrice;
            uint256 valueOut = f.executedBuy * f.buyPrice;
            assertLe(valueOut, valueIn, "a fill took out more than it put in");
            assertLe(
                (valueIn - valueOut) * BPS,
                valueIn * FEE_CAP_NOTIONAL_BPS,
                "a fill settled at its own price rather than the batch price"
            );
        }
    }

    /// I3 and I9. Settlement withholds the fee wedge and hands all of it out in the
    /// same call, so between transactions it holds nothing. A leak, a rounding
    /// remainder or a stuck balance all show up here as a nonzero number.
    function invariant_theSettlementCoreNeverHoldsATokenBetweenCalls() public view {
        assertEq(usdg.balanceOf(address(settlement)), 0, "usdg stuck in settlement");
        assertEq(nvda.balanceOf(address(settlement)), 0, "nvda stuck in settlement");
    }

    /// I4. Permit2 owns the bitmap and the handler replays settled nonces on
    /// purpose, so a second settlement on one nonce would land here.
    function invariant_noNonceEverSettlesTwice() public view {
        assertEq(handler.duplicateNonces(), 0, "a nonce settled twice");
    }

    /// I5. Every finalize either recorded its fills or reverted whole. A finalize
    /// that half happened would leave the two counters apart.
    function invariant_finalizeIsAllOrNothing() public view {
        assertEq(handler.callsFinalized(), handler.settledCount(), "a finalize landed without its fills");
        uint256 n = handler.settledCount();
        for (uint256 b = 0; b < n; ++b) {
            assertTrue(settlement.finalized(handler.settledAt(b).id), "recorded batch is not finalized");
        }
    }

    /// I6. What the solver walked away with, against the cap the contract states.
    function invariant_theSolverNeverTakesMoreThanItsCap() public view {
        uint256 n = handler.settledCount();
        for (uint256 b = 0; b < n; ++b) {
            SettlementHandler.SettledBatch memory batch = handler.settledAt(b);
            uint256 byShare = ((batch.savingsUsd + batch.solverFeeUsd) * FEE_CAP_SHARE_BPS) / BPS;
            uint256 byNotional = (batch.notionalUsd * FEE_CAP_NOTIONAL_BPS) / BPS;
            uint256 cap = byShare < byNotional ? byShare : byNotional;
            assertLe(batch.solverFeeUsd, cap, "solver took more than the cap");
        }
    }

    /// I7. The clearing price of every settled batch, against the oracle reference
    /// and the deviation the session allows.
    function invariant_everyBatchPriceStaysInsideItsBand() public view {
        uint256 n = handler.settledCount();
        for (uint256 b = 0; b < n; ++b) {
            SettlementHandler.SettledBatch memory batch = handler.settledAt(b);
            _assertInBand(batch.quotePrice, batch.quoteRef, batch.maxDevBps);
            _assertInBand(batch.basePrice, batch.baseRef, batch.maxDevBps);
        }
    }

    /// I8. Nobody is made worse off. Every fill beat the venue quote it was
    /// measured against, or the batch would not have been allowed to clear.
    function invariant_noFillIsWorseThanItsBaseline() public view {
        uint256 n = handler.fillCount();
        for (uint256 k = 0; k < n; ++k) {
            SettlementHandler.Fill memory f = handler.fillAt(k);
            assertGe(f.executedBuy, f.baselineQuote, "a fill came out under its baseline");
        }
    }

    /// The dishonest actions are the reason the rest of this file means anything.
    function invariant_noDishonestSolutionEverSettles() public view {
        assertEq(handler.dishonestAccepted(), 0, "a solution that broke a rule settled anyway");
    }

    /// I11. The governor sets allowlists and caps and nothing else. It has never
    /// held a token here and there is no path that would give it one.
    function invariant_theGovernorNeverHoldsAToken() public view {
        assertEq(usdg.balanceOf(governor), 0, "governor holds usdg");
        assertEq(nvda.balanceOf(governor), 0, "governor holds nvda");
    }

    /// An invariant suite that never reached a settlement would pass every line
    /// above while proving nothing at all. This drives the same handler through a
    /// fixed sequence so the claim that the honest actions clear, and that every
    /// dishonest one is refused, is checked rather than assumed.
    function test_theHandlerActuallyReachesSettlement() public {
        handler.actSettleBatch(1);
        handler.actSettleWithVenue(2);
        handler.actWarpTime(3);
        handler.actSettleBatch(4);

        assertEq(handler.settledCount(), 3, "the honest actions did not clear");
        assertEq(handler.fillCount(), 6, "a settled batch did not record both legs");
    }

    function test_everyDishonestShapeIsRefused() public {
        handler.actSettleBatch(1);
        for (uint256 kind = 0; kind <= 6; ++kind) {
            handler.actSubmitDishonest(kind);
            handler.actWarpTime(kind + 1);
        }
        handler.actReuseNonce(9);

        assertEq(handler.dishonestAccepted(), 0, "a solution that broke a rule settled anyway");
        assertEq(handler.duplicateNonces(), 0, "a nonce settled twice");
    }

    function _assertInBand(uint256 price, uint256 ref, uint16 maxDevBps) internal pure {
        uint256 diff = price > ref ? price - ref : ref - price;
        assertLe(diff * BPS, ref * maxDevBps, "clearing price outside the session band");
    }
}
