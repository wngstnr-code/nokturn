// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {ClearingVerifier} from "../src/ClearingVerifier.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {Settlement} from "../src/Settlement.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {IClearingVerifier} from "../src/interfaces/IClearingVerifier.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../src/interfaces/ISolverRegistry.sol";
import {Execution, Intent, Session, Solution, VenueCall} from "../src/types/Types.sol";
import {Addresses} from "../script/Addresses.sol";
import {CalendarFixture} from "../script/Calendar.sol";
import {StockTokenGate} from "../script/StockTokenGate.sol";
import {MirrorFeed} from "../script/testnet/MirrorFeed.sol";
import {TestQuoteToken} from "../script/testnet/TestQuoteToken.sol";
import {TestStockToken} from "../script/testnet/TestStockToken.sol";
import {TestV3Pool} from "../script/testnet/TestV3Pool.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockSolverRegistry} from "./mocks/MockSolverRegistry.sol";

/// @notice One whole batch on the chain 46630 fixtures, from intent to receipt.
/// Everything a testnet batch touches is the real contract, wired the way
/// Bootstrap and SetFeeds wire it, with two exceptions. Permit2 and the solver
/// registry are the suite's usual doubles, because neither is what this file asks
/// about. What it asks is whether a mirrored price and a pool that swaps are
/// enough for Settlement to clear, route and finalize.
///
/// The solutions are built the way script/demo/ForkDemo.s.sol builds them against
/// mainnet, so a batch that clears here is one the demo solver would also send.
contract TestnetBatchTest is Test {
    uint256 constant WAD = 1e18;
    uint256 constant BPS = 10_000;

    /// Wednesday 11 March 2026. The bell is 13:30 UTC and the batch is ten minutes
    /// in, aligned to the ten second OPEN batch and clear of the guard band.
    uint64 constant DAY_OPEN = 1_773_235_800;
    uint64 constant BATCH_ID = 1_773_236_400;
    /// Friday 13 March 2026 at the 20:00 UTC close, and Saturday noon UTC after it.
    uint64 constant FRIDAY_CLOSE = 1_773_432_000;
    uint64 constant SATURDAY_NOON = 1_773_489_600;

    /// The mainnet NVDA pool, fee and depth read on 3 October 2026.
    uint24 constant FEE = 500;
    int24 constant SPACING = 10;
    uint128 constant LIQUIDITY = 19_531_557_485_415_257_411;

    /// Same rule as ForkDemo. Withhold an eighth of the surplus as the fee.
    uint256 constant WITHHOLD_SHARE_OF_SURPLUS = 8;

    SessionManager sessions;
    PriceOracle oracle;
    Settlement settlement;
    UniswapV3Adapter adapter;
    MockPermit2 permit2;
    MockSolverRegistry registry;

    TestQuoteToken quote;
    TestStockToken nvda;
    MirrorFeed quoteFeed;
    MirrorFeed nvdaFeed;
    TestV3Pool pool;

    address governor = address(0x60174E);
    address solver = address(0x501E);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.warp(DAY_OPEN - 3600);

        sessions = new SessionManager(governor);
        vm.startPrank(governor);
        sessions.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(sessions, CalendarFixture.loadDays());
        vm.stopPrank();

        quote = new TestQuoteToken();
        nvda = new TestStockToken("Nokturn Test NVDA", "tNVDA", StockTokenGate.BEACON, 1.0032e18);
        quoteFeed = new MirrorFeed(address(this), Addresses.FEED_USDG, 8, "mirror of USDG / USD on 4663");
        nvdaFeed = new MirrorFeed(address(this), Addresses.FEED_NVDA, 8, "mirror of tNVDA / USD on 4663");
        pool = new TestV3Pool(
            address(nvda), address(quote), address(nvdaFeed), address(quoteFeed), FEE, SPACING, LIQUIDITY
        );
        nvda.mint(address(pool), 1e27);
        quote.mint(address(pool), 1e18);

        // What tools/mirror.py --once does before Deploy runs.
        quoteFeed.push(100, 1e8, DAY_OPEN - 3600);
        nvdaFeed.push(200, 180.25e8, DAY_OPEN - 3600);
        pool.sync();

        adapter = new UniswapV3Adapter(governor);
        oracle = new PriceOracle(ISessionManager(address(sessions)), governor);
        permit2 = new MockPermit2();
        registry = new MockSolverRegistry();
        registry.setActive(solver, true);

        settlement = new Settlement(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            IClearingVerifier(address(new ClearingVerifier())),
            ISolverRegistry(address(registry)),
            ISignatureTransfer(address(permit2)),
            address(0x7EA),
            governor,
            address(0x6A4D1A4)
        );

        // Bootstrap and then SetFeeds, with the mainnet staleness limits, because a
        // mirrored feed keeps mainnet timestamps and so keeps mainnet gaps.
        vm.startPrank(governor);
        adapter.setPool(address(pool));
        settlement.setTokenAllowed(address(quote), true);
        settlement.setTokenAllowed(address(nvda), true);
        settlement.setAdapterAllowed(address(adapter), true);
        settlement.setBaselineAdapter(address(adapter));
        oracle.setFeed(
            address(nvda), address(nvdaFeed), Addresses.STALENESS_OPEN_NVDA, Addresses.STALENESS_CLOSED_NVDA
        );
        oracle.setTwapSource(address(nvda), address(adapter), address(quote), Addresses.TWAP_WINDOW);
        oracle.setFeed(address(quote), address(quoteFeed), Addresses.STALENESS_USDG, Addresses.STALENESS_USDG);
        vm.stopPrank();

        quote.mint(alice, 10_000e6);
        quote.mint(bob, 10_000e6);
        nvda.mint(bob, 100e18);
        vm.prank(alice);
        quote.approve(address(permit2), type(uint256).max);
        vm.startPrank(bob);
        quote.approve(address(permit2), type(uint256).max);
        nvda.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
    }

    function test_theOracleReadsTheMirroredPriceAsHealthy() public {
        vm.warp(BATCH_ID);
        (uint256 price,, bool healthy) = oracle.refPrice(address(nvda));
        assertTrue(healthy);
        assertEq(price, 180.25e18);
        (,, bool agree) = oracle.dualCheck(address(nvda));
        assertTrue(agree);
    }

    /// Two buyers and no seller. Nothing nets, the whole volume goes through the
    /// testnet pool in one swap, and each buyer receives a share of what came out.
    function test_aRoutedBatchSwapsThroughThePoolAndFinalizes() public {
        vm.warp(BATCH_ID);
        Solution memory s = _routed(BATCH_ID, 1000e6);
        uint256 buyAlice = s.executions[0].executedBuy;
        uint256 buyBob = s.executions[1].executedBuy;
        uint256 poolQuote = quote.balanceOf(address(pool));
        uint160 before = _sqrtPrice();

        _submitAndFinalize(s);

        assertTrue(settlement.finalized(BATCH_ID));
        assertEq(nvda.balanceOf(alice), buyAlice);
        assertEq(nvda.balanceOf(bob), 100e18 + buyBob);
        assertEq(quote.balanceOf(address(pool)) - poolQuote, 1000e6, "the pool took the whole volume");
        // sqrtPrice is token1 per token0, so buying the stock lowers it when the
        // quote token sorts first.
        if (pool.token0() == address(quote)) assertLt(_sqrtPrice(), before, "buying moved the price");
        else assertGt(_sqrtPrice(), before, "buying moved the price");
    }

    function _sqrtPrice() internal view returns (uint160 price) {
        (price,,,,,,) = pool.slot0();
    }

    /// One buyer and one seller. They clear against each other inside the pool's
    /// spread, nothing touches the pool, and both beat what it would have given.
    function test_aNettedBatchBeatsThePoolAndNeverTouchesIt() public {
        vm.warp(BATCH_ID);
        Solution memory s = _netted(BATCH_ID, 1000e6);
        assertGt(s.executions[0].executedBuy, s.baselineQuotes[0], "alice beats the pool");
        assertGt(s.executions[1].executedBuy, s.baselineQuotes[1], "bob beats the pool");
        assertGt(s.claimedSavings, 0);
        uint256 buyAlice = s.executions[0].executedBuy;
        uint256 poolQuote = quote.balanceOf(address(pool));

        _submitAndFinalize(s);

        assertTrue(settlement.finalized(BATCH_ID));
        assertEq(nvda.balanceOf(alice), buyAlice);
        assertEq(quote.balanceOf(address(pool)), poolQuote, "the pool was never called");
    }

    /// The equity feed freezes for the weekend on mainnet, so the mirror freezes
    /// with it. The oracle moves to the pool twap with the Friday round as anchor,
    /// and a batch still clears.
    function test_aWeekendBatchClearsOnTheTwapWhileTheMirrorIsFrozen() public {
        vm.warp(FRIDAY_CLOSE);
        quoteFeed.push(101, 1e8, FRIDAY_CLOSE);
        nvdaFeed.push(201, 182e8, FRIDAY_CLOSE);
        pool.sync();

        Session session = sessions.sessionAt(SATURDAY_NOON);
        assertEq(uint8(session), uint8(Session.CLOSED_WEEKEND));
        uint32 duration = sessions.batchDuration(session);
        uint64 batchId = SATURDAY_NOON - (SATURDAY_NOON % duration);

        vm.warp(batchId);
        (uint256 price,, bool healthy) = oracle.refPrice(address(nvda));
        assertTrue(healthy);
        assertApproxEqRel(price, 182e18, 1e14);

        Solution memory s = _routed(batchId, 500e6);
        uint256 buyAlice = s.executions[0].executedBuy;
        _submitAndFinalizeAt(s, batchId, duration);
        assertTrue(settlement.finalized(batchId));
        assertEq(nvda.balanceOf(alice), buyAlice, "settled, not passed through");
    }

    function _submitAndFinalize(Solution memory s) internal {
        _submitAndFinalizeAt(s, BATCH_ID, sessions.batchDuration(Session.OPEN));
    }

    function _submitAndFinalizeAt(Solution memory s, uint64 batchId, uint32 duration) internal {
        vm.warp(batchId + 1);
        vm.prank(solver);
        settlement.submitSolution(s);
        vm.warp(uint256(batchId) + duration + 20);
        settlement.finalize(batchId, s);
    }

    function _unitPrice(address token, uint8 decimals) internal view returns (uint256) {
        (uint256 price,, bool healthy) = oracle.refPrice(token);
        require(healthy, "oracle is not healthy for this token");
        return (price * WAD) / (10 ** decimals);
    }

    function _withinBand(uint64 batchId, uint256 price) internal view {
        uint256 ref = _unitPrice(address(nvda), 18);
        uint256 gap = price > ref ? price - ref : ref - price;
        assertLe(gap * BPS, ref * sessions.maxDeviationBps(sessions.sessionAt(batchId)), "outside the band");
    }

    /// ForkDemo._buildRouted, against the testnet pool.
    function _routed(uint64 batchId, uint256 total) internal view returns (Solution memory s) {
        s.tokens = new address[](2);
        s.tokens[0] = address(quote);
        s.tokens[1] = address(nvda);
        s.prices = new uint256[](2);
        s.prices[0] = _unitPrice(address(quote), 6);

        uint256 sellAlice = (total * 6000) / BPS;
        uint256 sellBob = total - sellAlice;
        uint256 out = adapter.quoteFromState(address(quote), address(nvda), total);
        uint256 buyAlice = (out * sellAlice) / total;
        uint256 buyBob = out - buyAlice;

        uint256 impliedAlice = (sellAlice * s.prices[0]) / buyAlice;
        uint256 impliedBob = (sellBob * s.prices[0]) / buyBob;
        s.prices[1] = impliedAlice < impliedBob ? impliedAlice : impliedBob;
        _withinBand(batchId, s.prices[1]);

        _legs(s, [sellAlice, sellBob], [buyAlice, buyBob], [address(nvda), address(nvda)]);
        s.venueCalls = new VenueCall[](1);
        s.venueCalls[0] = VenueCall({
            adapter: address(adapter),
            tokenIn: address(quote),
            tokenOut: address(nvda),
            amountIn: total,
            minOut: out
        });

        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = buyAlice;
        s.baselineQuotes[1] = buyBob;
        s.solver = solver;
        s.batchId = batchId;
        s.claimedSavings = 0;
    }

    /// ForkDemo._buildNetted, against the testnet pool.
    function _netted(uint64 batchId, uint256 sellQuote) internal view returns (Solution memory s) {
        s.tokens = new address[](2);
        s.tokens[0] = address(quote);
        s.tokens[1] = address(nvda);
        s.prices = new uint256[](2);
        s.prices[0] = _unitPrice(address(quote), 6);

        uint256 askOut = adapter.quoteFromState(address(quote), address(nvda), sellQuote);
        uint256 bidOut = adapter.quoteFromState(address(nvda), address(quote), askOut);
        uint256 buyNvda = (askOut * (2 * sellQuote)) / (sellQuote + bidOut);
        assertGt(buyNvda, askOut, "netting did not beat the pool");

        s.prices[1] = (sellQuote * s.prices[0]) / buyNvda;
        _withinBand(batchId, s.prices[1]);

        uint256 venueOutQuote = adapter.quoteFromState(address(nvda), address(quote), buyNvda);
        uint256 surplusUsd =
            ((buyNvda - askOut) * s.prices[1]) / WAD + ((sellQuote - venueOutQuote) * s.prices[0]) / WAD;
        uint256 fee = (surplusUsd * WAD) / (s.prices[0] * WITHHOLD_SHARE_OF_SURPLUS);
        uint256 buyQuote = sellQuote - fee;

        _legs(s, [sellQuote, buyNvda], [buyNvda, buyQuote], [address(nvda), address(quote)]);
        s.venueCalls = new VenueCall[](0);

        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = askOut;
        s.baselineQuotes[1] = venueOutQuote;
        s.solver = solver;
        s.batchId = batchId;
        s.claimedSavings =
            ((buyNvda - askOut) * s.prices[1]) / WAD + ((buyQuote - venueOutQuote) * s.prices[0]) / WAD;
    }

    /// @dev Alice sells the quote token, Bob sells whatever buys[1] is not. Split
    /// out of the builders because via_ir runs out of stack with it inline.
    function _legs(
        Solution memory s,
        uint256[2] memory sells,
        uint256[2] memory buys,
        address[2] memory buyTokens
    ) internal view {
        address bobSells = buyTokens[1] == address(quote) ? address(nvda) : address(quote);
        s.intents = new Intent[](2);
        s.intents[0] = _intent(alice, address(quote), buyTokens[0], sells[0], buys[0], 1);
        s.intents[1] = _intent(bob, bobSells, buyTokens[1], sells[1], buys[1], 2);
        s.signatures = new bytes[](2);
        s.executions = new Execution[](2);
        s.executions[0] = Execution({intentIndex: 0, executedSell: sells[0], executedBuy: buys[0]});
        s.executions[1] = Execution({intentIndex: 1, executedSell: sells[1], executedBuy: buys[1]});
    }

    function _intent(
        address owner,
        address sellToken,
        address buyToken,
        uint256 sell,
        uint256 minBuy,
        uint256 nonce
    ) internal pure returns (Intent memory) {
        return Intent({
            owner: owner,
            receiver: owner,
            sellToken: sellToken,
            buyToken: buyToken,
            sellAmount: sell,
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
}
