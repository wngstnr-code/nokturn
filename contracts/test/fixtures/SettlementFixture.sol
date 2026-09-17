// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ClearingVerifier} from "../../src/ClearingVerifier.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {Settlement} from "../../src/Settlement.sol";
import {IClearingVerifier} from "../../src/interfaces/IClearingVerifier.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {ISettlement} from "../../src/interfaces/ISettlement.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../../src/interfaces/ISolverRegistry.sol";
import {Execution, Intent, Session, SessionMask, Solution, VenueCall} from "../../src/types/Types.sol";
import {CalendarFixture} from "./CalendarFixture.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSolverRegistry} from "../mocks/MockSolverRegistry.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";

/// @dev The wiring every settlement suite needs. It is a fork of no state at all,
/// just the four contracts, two tokens and two feeds that a batch cannot be built
/// without, kept here so a suite that asks one narrow question does not have to
/// carry eighty lines of setup to ask it.
abstract contract SettlementFixture is Test {
    SessionManager sessions;
    PriceOracle oracle;
    ClearingVerifier verifier;
    Settlement settlement;
    MockPermit2 permit2;
    MockSolverRegistry registry;
    MockSwapAdapter adapter;

    MockERC20 usdg;
    MockERC20 nvda;
    MockAggregator usdgFeed;
    MockAggregator nvdaFeed;

    address governor = address(0x60174E);
    address treasury = address(0x7EA);
    address solver = address(0x501E);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    /// Wednesday 11 March 2026, one open batch. 09:30 ET is 13:30 UTC in EDT.
    uint64 constant DAY_OPEN = 1_773_235_800;
    /// Ten minutes after the bell, aligned to the 10 second OPEN batch. A batch
    /// closer to the boundary lands in the guard band and is refused, which is the
    /// point of the guard band.
    uint64 constant BATCH_ID = 1_773_236_400;

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
        adapter = new MockSwapAdapter();

        oracle = new PriceOracle(ISessionManager(address(sessions)), governor);
        vm.startPrank(governor);
        oracle.setFeed(address(usdg), address(usdgFeed), 6000, 20_000);
        oracle.setFeed(address(nvda), address(nvdaFeed), 6000, 20_000);
        oracle.setTwapSource(address(usdg), address(adapter), address(nvda), 1800);
        oracle.setTwapSource(address(nvda), address(adapter), address(usdg), 1800);
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
            governor
        );

        vm.startPrank(governor);
        settlement.setTokenAllowed(address(usdg), true);
        settlement.setTokenAllowed(address(nvda), true);
        settlement.setAdapterAllowed(address(adapter), true);
        vm.stopPrank();

        usdgFeed.push(1e8, DAY_OPEN);
        nvdaFeed.push(200e8, DAY_OPEN);

        usdg.mint(alice, 1000e6);
        nvda.mint(bob, 10e18);
        vm.prank(alice);
        usdg.approve(address(permit2), type(uint256).max);
        vm.prank(bob);
        nvda.approve(address(permit2), type(uint256).max);

        // The adapter quotes out = in * rate / 1e18 in raw units, so the rate has
        // to carry the decimal gap between a six decimal quote and an eighteen
        // decimal base. 200 USDG in gives 1 NVDA out.
        adapter.setRate(address(usdg), address(nvda), 5e27);
        adapter.setRate(address(nvda), address(usdg), 200e6);
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

    /// Alice buys 1 NVDA with 200 USDG, Bob sells 1 NVDA for 200 USDG. They net
    /// against each other and no venue is touched at all.
    function _nettedSolution() internal view returns (Solution memory s) {
        s.batchId = BATCH_ID;
        s.intents = new Intent[](2);
        s.intents[0] = _intent(alice, address(usdg), address(nvda), 200e6, 1e18, 1);
        s.intents[1] = _intent(bob, address(nvda), address(usdg), 1e18, 200e6, 2);

        s.signatures = new bytes[](2);
        s.tokens = new address[](2);
        s.tokens[0] = address(usdg);
        s.tokens[1] = address(nvda);
        s.prices = new uint256[](2);
        // Per smallest unit. A dollar of USDG is 1e30 here because USDG has six
        // decimals, and one NVDA at 200 dollars is 200e18 because it has eighteen.
        s.prices[0] = 1e30;
        s.prices[1] = 200e18;

        s.executions = new Execution[](2);
        s.executions[0] = Execution({intentIndex: 0, executedSell: 200e6, executedBuy: 1e18});
        s.executions[1] = Execution({intentIndex: 1, executedSell: 1e18, executedBuy: 200e6});

        s.venueCalls = new VenueCall[](0);
        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = 0.99e18; // the venue would have given less
        s.baselineQuotes[1] = 198e6;
        s.solver = solver;
    }

    function _submit(Solution memory s) internal returns (Solution memory) {
        vm.warp(BATCH_ID + 1);
        uint256 savings = 0.01e18 * 200 + 2e18; // 2 USD of NVDA plus 2 USD of USDG
        s.claimedSavings = savings;
        vm.prank(solver);
        settlement.submitSolution(s);
        return s;
    }
}
