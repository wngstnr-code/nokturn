// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {UniswapV3Adapter} from "../../src/adapters/UniswapV3Adapter.sol";
import {IUniswapV3Pool} from "../../src/interfaces/IUniswapV3Pool.sol";
import {ForkFixture} from "../fixtures/ForkFixture.sol";

/// @notice The test that decides whether the savings number means anything. The
/// baseline has to equal what the real pool would actually pay, to the wei, on the
/// same block. A mock pool would let us choose our own baseline, and that is the
/// one number this protocol must never choose for itself.
contract UniswapV3AdapterForkTest is Test {
    UniswapV3Adapter adapter;
    address governor = address(0x60174E);

    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    /// parameter.md section 10. USDG is token0 for NVDA and token1 for TSLA, and
    /// TSLA's depth sits in fee 3000 rather than 500.
    address constant POOL_NVDA_500 = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3;
    address constant POOL_TSLA_3000 = 0xf4ACdAEEB7022862A763C9B1B885e11191c889E3;

    function setUp() public {
        ForkFixture.selectMainnet();
        adapter = new UniswapV3Adapter(governor);
        vm.startPrank(governor);
        adapter.setPool(POOL_NVDA_500);
        adapter.setPool(POOL_TSLA_3000);
        vm.stopPrank();
    }

    /// Quotes from state, then performs the real swap on the same block and puts
    /// the state back. Zero difference, or the savings claim collapses.
    function _assertZeroDifference(address tokenIn, address tokenOut, uint256 amountIn) internal {
        uint256 quoted = adapter.quoteFromState(tokenIn, tokenOut, amountIn);

        uint256 snapshot = vm.snapshotState();
        deal(tokenIn, address(this), amountIn);
        IERC20(tokenIn).approve(address(adapter), amountIn);
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        adapter.swap(tokenIn, tokenOut, amountIn, 0);
        uint256 received = IERC20(tokenOut).balanceOf(address(this)) - before;
        vm.revertToState(snapshot);

        assertEq(quoted, received, "quoteFromState must equal the real swap to the wei");
    }

    function test_nvdaBuyMatchesTheRealSwap() public {
        _assertZeroDifference(USDG, NVDA, 1000e6);
    }

    function test_nvdaSellMatchesTheRealSwap() public {
        _assertZeroDifference(NVDA, USDG, 5e18);
    }

    /// USDG sits on the other side here, so a wrong zeroForOne would be quietly
    /// wrong rather than reverting.
    function test_tslaBothDirectionsMatchTheRealSwap() public {
        _assertZeroDifference(USDG, TSLA, 2000e6);
        _assertZeroDifference(TSLA, USDG, 3e18);
    }

    /// Large enough to walk through initialized ticks, which is the path a quote is
    /// most likely to get wrong.
    function test_largeTradeCrossingTicksStillMatches() public {
        _assertZeroDifference(USDG, NVDA, 250_000e6);
    }

    /// parameter.md section 4B calls MAX_TICK_CROSSINGS an initial guess and asks
    /// for the measured distribution instead. CAP_PER_BATCH is 5000 USD at launch,
    /// so this walks from a median ticket up to ten times the cap and prints what
    /// the real pool actually costs to cross.
    function test_measureTickCrossingsAcrossTheCapRange() public {
        uint256[7] memory sizes = [uint256(57e6), 1000e6, 5000e6, 10_000e6, 50_000e6, 250_000e6, 1_000_000e6];
        uint16 worstCrossings;
        uint16 worstSteps;

        for (uint256 n = 0; n < sizes.length; ++n) {
            (uint256 out, uint16 crossings, uint16 steps) = adapter.quoteWithStats(USDG, NVDA, sizes[n]);
            emit log_named_uint("usdg in", sizes[n] / 1e6);
            emit log_named_uint("  nvda out (1e18)", out);
            emit log_named_uint("  crossings", crossings);
            emit log_named_uint("  loop steps", steps);
            if (crossings > worstCrossings) worstCrossings = crossings;
            if (steps > worstSteps) worstSteps = steps;
        }

        emit log_named_uint("worst crossings over the range", worstCrossings);
        emit log_named_uint("worst loop steps over the range", worstSteps);
        assertLt(worstCrossings, 32, "measured crossings must sit under the configured cap");
        assertLt(worstSteps, 128, "and so must loop steps");
    }

    function test_theTokenOrderIsReadFromThePoolNotAssumed() public view {
        assertEq(IUniswapV3Pool(POOL_NVDA_500).token0(), USDG, "USDG is token0 for NVDA");
        assertEq(IUniswapV3Pool(POOL_TSLA_3000).token0(), TSLA, "TSLA is token0 for itself");
    }

    /// Both directions, because the decimal scaling is the easy thing to get wrong
    /// and a raw ratio looks plausible while being off by 1e12.
    function test_twapIsScaledByDecimalsInBothDirections() public view {
        uint256 nvdaInUsdg = adapter.twap(NVDA, USDG, 1800);
        assertGt(nvdaInUsdg, 50e18, "NVDA is not worth less than 50 USDG");
        assertLt(nvdaInUsdg, 1000e18, "and not more than 1000");

        uint256 usdgInNvda = adapter.twap(USDG, NVDA, 1800);
        // The two are reciprocals, within the rounding of one round trip.
        assertApproxEqRel(nvdaInUsdg * usdgInNvda / 1e18, 1e18, 0.0001e18);
    }
}
