// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {TickMath} from "v4-core/libraries/TickMath.sol";

import {IUniswapV3Pool} from "../../src/interfaces/IUniswapV3Pool.sol";

/// @title A concentrated liquidity pool with one flat range, for chain 46630
/// @notice The adapter reads a pool rather than quoting it, so the rehearsal needs
/// something that answers those reads coherently. Liquidity is constant and no
/// tick is initialized, which means a quote of any ordinary size finishes inside
/// the first step and never crosses anything.
///
/// It does not swap. A settlement on 46630 would need a solver and a book, and
/// neither exists there. swap reverts rather than pretending, because a venue that
/// silently returns nothing is worse than one that says no.
contract TestV3Pool is IUniswapV3Pool {
    error TestPoolDoesNotSwap();

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    int24 internal immutable currentTick;
    uint128 internal immutable currentLiquidity;

    constructor(address token0_, address token1_, int24 tick_, uint24 fee_, uint128 liquidity_) {
        token0 = token0_;
        token1 = token1_;
        currentTick = tick_;
        fee = fee_;
        tickSpacing = 60;
        currentLiquidity = liquidity_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (TickMath.getSqrtPriceAtTick(currentTick), currentTick, 0, 1, 1, 0, true);
    }

    function liquidity() external view returns (uint128) {
        return currentLiquidity;
    }

    function tickBitmap(int16) external pure returns (uint256) {
        return 0;
    }

    function ticks(int24)
        external
        pure
        returns (uint128, int128, uint256, uint256, int56, uint160, uint32, bool)
    {
        return (0, 0, 0, 0, 0, 0, 0, false);
    }

    /// @dev A flat history at the current tick. The adapter takes the difference
    /// over the window and divides, so the answer is the tick itself.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 k = 0; k < secondsAgos.length; ++k) {
            // forge-lint: disable-next-line(unsafe-typecast)
            int56 elapsed = int56(uint56(block.timestamp - secondsAgos[k]));
            tickCumulatives[k] = int56(currentTick) * elapsed;
        }
    }

    function swap(address, bool, int256, uint160, bytes calldata) external pure returns (int256, int256) {
        revert TestPoolDoesNotSwap();
    }
}
