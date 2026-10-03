// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {IVenueAdapter} from "../src/interfaces/IVenueAdapter.sol";
import {MirrorFeed} from "../script/testnet/MirrorFeed.sol";
import {TestQuoteToken} from "../script/testnet/TestQuoteToken.sol";
import {TestStockToken} from "../script/testnet/TestStockToken.sol";
import {TestV3Pool} from "../script/testnet/TestV3Pool.sol";

contract Underpayer {
    function swap(TestV3Pool pool, bool zeroForOne, int256 amount) external {
        pool.swap(
            address(this),
            zeroForOne,
            amount,
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            ""
        );
    }

    function uniswapV3SwapCallback(int256, int256, bytes calldata) external {}
}

contract TestnetFixturesTest is Test {
    address constant SOURCE = address(0x4663);
    address constant LOW = address(0x1000);
    address constant MID = address(0x2000);
    address constant HIGH = address(0x3000);

    /// A literal rather than block.timestamp kept in a local. Under via_ir the
    /// local is rematerialized after vm.warp and silently moves with it.
    uint256 constant T0 = 1_759_500_000;

    /// The NVDA pool on mainnet, fee and depth read on 3 October 2026.
    uint24 constant FEE = 500;
    int24 constant SPACING = 10;
    uint128 constant LIQUIDITY = 19_531_557_485_415_257_411;

    TestQuoteToken quote;
    TestStockToken stockBelow;
    TestStockToken stockAbove;
    MirrorFeed quoteFeed;
    MirrorFeed feedBelow;
    MirrorFeed feedAbove;
    TestV3Pool poolBelow;
    TestV3Pool poolAbove;
    UniswapV3Adapter adapter;

    function setUp() public {
        vm.warp(T0);

        deployCodeTo("TestQuoteToken.sol:TestQuoteToken", MID);
        deployCodeTo(
            "TestStockToken.sol:TestStockToken", abi.encode("Below", "tBLW", address(0xbeac), 1e18), LOW
        );
        deployCodeTo(
            "TestStockToken.sol:TestStockToken", abi.encode("Above", "tABV", address(0xbeac), 1e18), HIGH
        );
        quote = TestQuoteToken(MID);
        stockBelow = TestStockToken(LOW);
        stockAbove = TestStockToken(HIGH);

        quoteFeed = new MirrorFeed(address(this), SOURCE, 8, "mirror of USDG / USD on 4663");
        feedBelow = new MirrorFeed(address(this), SOURCE, 8, "mirror of tBLW / USD on 4663");
        feedAbove = new MirrorFeed(address(this), SOURCE, 8, "mirror of tABV / USD on 4663");

        poolBelow = _pool(stockBelow, feedBelow);
        poolAbove = _pool(stockAbove, feedAbove);

        adapter = new UniswapV3Adapter(address(this));

        quoteFeed.push(10, 1e8, block.timestamp - 60);
        feedBelow.push(10, 180.25e8, block.timestamp - 30);
        feedAbove.push(10, 180.25e8, block.timestamp - 30);
        poolBelow.sync();
        poolAbove.sync();
        adapter.setPool(address(poolBelow));
        adapter.setPool(address(poolAbove));

        stockBelow.mint(address(this), 1e30);
        stockAbove.mint(address(this), 1e30);
        quote.mint(address(this), 1e30);
        stockBelow.approve(address(adapter), type(uint256).max);
        stockAbove.approve(address(adapter), type(uint256).max);
        quote.approve(address(adapter), type(uint256).max);
    }

    function _pool(TestStockToken stock, MirrorFeed feed) internal returns (TestV3Pool pool) {
        pool = new TestV3Pool(
            address(stock), address(quote), address(feed), address(quoteFeed), FEE, SPACING, LIQUIDITY
        );
        stock.mint(address(pool), 1e27);
        quote.mint(address(pool), 1e18);
    }

    function test_tokenOrderFollowsAddresses() public view {
        assertEq(poolBelow.token0(), address(stockBelow));
        assertEq(poolAbove.token0(), address(quote));
    }

    function test_syncPricesTheStockAtTheFeedRatio() public {
        vm.warp(block.timestamp + 1800);
        // One tick is one basis point, and the price is floored onto a tick.
        assertApproxEqRel(adapter.twap(address(stockBelow), address(quote), 1800), 180.25e18, 1e14);
        assertApproxEqRel(adapter.twap(address(stockAbove), address(quote), 1800), 180.25e18, 1e14);
    }

    function test_syncFollowsTheQuoteFeedOffOneDollar() public {
        quoteFeed.push(11, 0.995e8, block.timestamp);
        poolBelow.sync();
        vm.warp(block.timestamp + 1800);
        assertApproxEqRel(adapter.twap(address(stockBelow), address(quote), 1800), 181.155778e18, 1e14);
    }

    function testFuzz_swapMatchesTheQuoteToTheWei(uint256 amountIn, bool stockIn, bool below) public {
        TestStockToken stock = below ? stockBelow : stockAbove;
        amountIn = stockIn ? bound(amountIn, 1e9, 50_000e18) : bound(amountIn, 1, 5_000_000e6);
        (address tokenIn, address tokenOut) =
            stockIn ? (address(stock), address(quote)) : (address(quote), address(stock));

        uint256 quoted = adapter.quoteFromState(tokenIn, tokenOut, amountIn);
        uint256 before = TestQuoteToken(tokenOut).balanceOf(address(this));
        uint256 received = adapter.swap(tokenIn, tokenOut, amountIn, 0);

        assertEq(received, quoted);
        assertEq(TestQuoteToken(tokenOut).balanceOf(address(this)) - before, quoted);
    }

    function test_aSwapLargeEnoughToCrossWordsStillMatches() public {
        uint256 amountIn = 2_000_000e18;
        uint256 quoted = adapter.quoteFromState(address(stockBelow), address(quote), amountIn);
        (,, uint16 steps) = adapter.quoteWithStats(address(stockBelow), address(quote), amountIn);
        assertGt(steps, 1);
        assertEq(adapter.swap(address(stockBelow), address(quote), amountIn, 0), quoted);
    }

    function test_swapMovesThePriceAndSyncPutsItBack() public {
        (uint160 start, int24 startTick,,,,,) = poolBelow.slot0();
        adapter.swap(address(quote), address(stockBelow), 2_000_000e6, 0);
        (uint160 moved,,,,,,) = poolBelow.slot0();
        assertGt(moved, start);

        poolBelow.sync();
        (uint160 back, int24 backTick,,,,,) = poolBelow.slot0();
        assertEq(back, start);
        assertEq(backTick, startTick);
    }

    function test_twapWeighsEachTickByItsTime() public {
        (, int24 first,,,,,) = poolBelow.slot0();

        vm.warp(T0 + 900);
        feedBelow.push(11, 198.275e8, T0 + 900);
        poolBelow.sync();
        (, int24 second,,,,,) = poolBelow.slot0();
        vm.warp(T0 + 1800);

        uint32[] memory ago = new uint32[](2);
        ago[0] = 1800;
        (int56[] memory cumulatives,) = poolBelow.observe(ago);
        assertEq(cumulatives[1] - cumulatives[0], int56(first) * 900 + int56(second) * 900);
    }

    function test_observeRefusesAWindowOlderThanItsHistory() public {
        uint32[] memory ago = new uint32[](1);
        ago[0] = 60;
        vm.expectRevert();
        poolBelow.observe(ago);
    }

    function test_anUninitializedPoolNeitherQuotesNorSwaps() public {
        TestV3Pool fresh = _pool(stockBelow, feedBelow);
        vm.expectRevert(abi.encodeWithSelector(IVenueAdapter.PoolNotInitialized.selector, address(fresh)));
        adapter.setPool(address(fresh));

        vm.expectRevert(TestV3Pool.NotInitialized.selector);
        fresh.swap(address(this), true, 1e18, TickMath.MIN_SQRT_PRICE + 1, "");
    }

    function test_syncRefusesAFeedWithNoRound() public {
        MirrorFeed empty = new MirrorFeed(address(this), SOURCE, 8, "empty");
        TestV3Pool pool = new TestV3Pool(
            address(stockBelow), address(quote), address(empty), address(quoteFeed), FEE, SPACING, LIQUIDITY
        );
        vm.expectRevert(abi.encodeWithSelector(TestV3Pool.UnhealthyFeed.selector, address(empty)));
        pool.sync();
    }

    function test_aCallerThatDoesNotPayIsRefused() public {
        Underpayer cheat = new Underpayer();
        vm.expectRevert();
        cheat.swap(poolBelow, true, 1e18);
    }

    function test_syncIsOpenToAnyone() public {
        feedBelow.push(11, 200e8, block.timestamp);
        vm.prank(address(0xdead));
        poolBelow.sync();
    }

    function test_onlyTheOperatorPushes() public {
        vm.prank(address(0xdead));
        vm.expectRevert(MirrorFeed.NotOperator.selector);
        feedBelow.push(11, 200e8, block.timestamp);
    }

    function test_pushRefusesAnythingNotNewer() public {
        vm.expectRevert(
            abi.encodeWithSelector(MirrorFeed.SourceRoundNotNewer.selector, uint80(10), uint80(10))
        );
        feedBelow.push(10, 200e8, block.timestamp);

        uint256 last = block.timestamp - 30;
        vm.expectRevert(abi.encodeWithSelector(MirrorFeed.UpdatedAtNotNewer.selector, last, uint64(last)));
        feedBelow.push(11, 200e8, last);

        vm.expectRevert(abi.encodeWithSelector(MirrorFeed.UpdatedAtInFuture.selector, block.timestamp + 1));
        feedBelow.push(11, 200e8, block.timestamp + 1);

        vm.expectRevert(abi.encodeWithSelector(MirrorFeed.NonPositiveAnswer.selector, int256(0)));
        feedBelow.push(11, 0, block.timestamp);
    }

    function test_mirroredRoundsWalkBackContiguously() public {
        vm.warp(T0 + 10);
        feedBelow.push(15, 181e8, T0 + 10);
        vm.warp(T0 + 20);
        feedBelow.push(40, 182e8, T0 + 20);

        (uint80 latest, int256 answer,, uint256 updatedAt,) = feedBelow.latestRoundData();
        assertEq(latest, 3);
        assertEq(answer, 182e8);
        assertEq(updatedAt, T0 + 20);
        assertEq(feedBelow.sourceRoundOf(2), 15);
        assertEq(feedBelow.sourceRoundOf(3), 40);

        (, int256 previous,,,) = feedBelow.getRoundData(2);
        assertEq(previous, 181e8);

        (,,, uint256 missing,) = feedBelow.getRoundData(4);
        assertEq(missing, 0);
        (,,, uint256 zeroth,) = feedBelow.getRoundData(0);
        assertEq(zeroth, 0);
    }
}
