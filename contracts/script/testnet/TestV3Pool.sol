// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {SwapMath} from "v4-core/libraries/SwapMath.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";
import {IUniswapV3Pool} from "../../src/interfaces/IUniswapV3Pool.sol";

interface IUniswapV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @title A concentrated liquidity pool with one flat range, for chain 46630
/// @notice Liquidity is constant and no tick is initialized, so a swap walks word
/// boundaries with the same SwapMath step the adapter quotes with. The quote and
/// the swap therefore agree to the wei, which is the gate the mainnet fork tests
/// hold the real pools to.
///
/// The price has exactly two ways to move. A swap moves it the way any V3 pool
/// moves. sync moves it to the ratio of two mirrored mainnet feeds, and nothing
/// else can set it, so no key chooses the price this pool quotes. See MirrorFeed.
contract TestV3Pool is IUniswapV3Pool {
    using SafeERC20 for IERC20;

    struct Observation {
        uint32 timestamp;
        int56 tickCumulative;
        int24 tick;
    }

    uint16 internal constant CARDINALITY = 256;
    uint256 internal constant Q192 = 1 << 192;

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    AggregatorV3Interface public immutable feed0;
    AggregatorV3Interface public immutable feed1;
    uint128 internal immutable flatLiquidity;

    uint160 internal sqrtPriceX96;
    int24 internal tick;
    uint16 internal observationIndex;
    uint16 internal observationCount;
    bool internal unlocked = true;
    Observation[CARDINALITY] internal observations;

    error NotInitialized();
    error Locked();
    error ZeroAmount();
    error BadPriceLimit(uint160 limit);
    error UnhealthyFeed(address feed);
    error PriceOutOfRange(uint160 sqrtPriceX96);
    error CallbackUnderpaid(uint256 expected, uint256 received);
    error ObservationTooOld(uint32 target, uint32 oldest);

    event Synced(uint160 sqrtPriceX96, int24 tick, uint80 round0, uint80 round1);
    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );

    /// @param stockFeed and quoteFeed price each side in USD, so the pool price is
    /// their ratio and a quote token that drifts off one dollar is priced as it is.
    constructor(
        address stock,
        address quote,
        address stockFeed,
        address quoteFeed,
        uint24 fee_,
        int24 tickSpacing_,
        uint128 liquidity_
    ) {
        bool stockFirst = stock < quote;
        (token0, token1) = stockFirst ? (stock, quote) : (quote, stock);
        (feed0, feed1) = stockFirst
            ? (AggregatorV3Interface(stockFeed), AggregatorV3Interface(quoteFeed))
            : (AggregatorV3Interface(quoteFeed), AggregatorV3Interface(stockFeed));
        fee = fee_;
        tickSpacing = tickSpacing_;
        flatLiquidity = liquidity_;
    }

    modifier lock() {
        if (!unlocked) revert Locked();
        unlocked = false;
        _;
        unlocked = true;
    }

    /// @notice Anyone may call it. The answer depends only on the two feeds.
    function sync() external lock {
        (uint80 round0, int256 answer0,, uint256 updated0,) = feed0.latestRoundData();
        (uint80 round1, int256 answer1,, uint256 updated1,) = feed1.latestRoundData();
        if (answer0 <= 0 || updated0 == 0) revert UnhealthyFeed(address(feed0));
        if (answer1 <= 0 || updated1 == 0) revert UnhealthyFeed(address(feed1));

        // Raw token1 per raw token0 is usd0 / usd1 scaled by the decimal gap. Both
        // sides are kept as integers until the one mulDiv, which carries 512 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 num = uint256(answer0) * 10 ** feed1.decimals() * 10 ** IERC20Metadata(token1).decimals();
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 den = uint256(answer1) * 10 ** feed0.decimals() * 10 ** IERC20Metadata(token0).decimals();
        uint256 root = Math.sqrt(FullMath.mulDiv(num, Q192, den));
        if (root < TickMath.MIN_SQRT_PRICE || root >= TickMath.MAX_SQRT_PRICE) {
            // forge-lint: disable-next-line(unsafe-typecast)
            revert PriceOutOfRange(uint160(root));
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        uint160 next = uint160(root);
        _move(next, TickMath.getTickAtSqrtPrice(next));
        emit Synced(next, tick, round0, round1);
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, tick, observationIndex, observationCount, CARDINALITY, 0, unlocked);
    }

    function liquidity() external view returns (uint128) {
        return flatLiquidity;
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

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (sqrtPriceX96 == 0) revert NotInitialized();
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 k = 0; k < secondsAgos.length; ++k) {
            // forge-lint: disable-next-line(unsafe-typecast)
            tickCumulatives[k] = _cumulativeAt(uint32(block.timestamp - secondsAgos[k]));
        }
    }

    /// @dev Uniswap V3 semantics. A positive amountSpecified is exact input.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external lock returns (int256 amount0, int256 amount1) {
        if (amountSpecified == 0) revert ZeroAmount();
        uint160 price = sqrtPriceX96;
        if (price == 0) revert NotInitialized();
        if (zeroForOne
                ? sqrtPriceLimitX96 >= price || sqrtPriceLimitX96 <= TickMath.MIN_SQRT_PRICE
                : sqrtPriceLimitX96 <= price || sqrtPriceLimitX96 >= TickMath.MAX_SQRT_PRICE) revert BadPriceLimit(sqrtPriceLimitX96);

        bool exactInput = amountSpecified > 0;
        int256 remaining = amountSpecified;
        int256 calculated;
        int24 current = tick;

        while (remaining != 0 && price != sqrtPriceLimitX96) {
            int24 nextTick = _nextWordBoundary(current, zeroForOne);
            uint160 sqrtAtNext = TickMath.getSqrtPriceAtTick(nextTick);
            uint160 target = (zeroForOne ? sqrtAtNext < sqrtPriceLimitX96 : sqrtAtNext > sqrtPriceLimitX96)
                ? sqrtPriceLimitX96
                : sqrtAtNext;

            // v4-core SwapMath reads a negative remainder as exact input, the
            // opposite sign of the V3 convention this function exposes.
            (uint160 after_, uint256 stepIn, uint256 stepOut, uint256 stepFee) =
                SwapMath.computeSwapStep(price, target, flatLiquidity, -remaining, fee);

            if (exactInput) {
                // forge-lint: disable-next-line(unsafe-typecast)
                remaining -= int256(stepIn + stepFee);
                // forge-lint: disable-next-line(unsafe-typecast)
                calculated -= int256(stepOut);
            } else {
                // forge-lint: disable-next-line(unsafe-typecast)
                remaining += int256(stepOut);
                // forge-lint: disable-next-line(unsafe-typecast)
                calculated += int256(stepIn + stepFee);
            }

            if (after_ == sqrtAtNext) {
                current = zeroForOne ? nextTick - 1 : nextTick;
            } else if (after_ != price) {
                current = TickMath.getTickAtSqrtPrice(after_);
            }
            price = after_;
        }

        (amount0, amount1) = zeroForOne == exactInput
            ? (amountSpecified - remaining, calculated)
            : (calculated, amountSpecified - remaining);

        _move(price, current);

        if (zeroForOne) {
            // forge-lint: disable-next-line(unsafe-typecast)
            if (amount1 < 0) IERC20(token1).safeTransfer(recipient, uint256(-amount1));
            _collect(token0, amount0, amount1, data);
        } else {
            // forge-lint: disable-next-line(unsafe-typecast)
            if (amount0 < 0) IERC20(token0).safeTransfer(recipient, uint256(-amount0));
            _collect(token1, amount1, amount0, data);
        }

        emit Swap(msg.sender, recipient, amount0, amount1, price, flatLiquidity, current);
    }

    function _collect(address tokenIn, int256 owed, int256 otherDelta, bytes calldata data) internal {
        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        (int256 delta0, int256 delta1) = tokenIn == token0 ? (owed, otherDelta) : (otherDelta, owed);
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(delta0, delta1, data);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - before;
        // forge-lint: disable-next-line(unsafe-typecast)
        if (received < uint256(owed)) revert CallbackUnderpaid(uint256(owed), received);
    }

    /// @dev The empty bitmap case of TickBitmap.nextInitializedTickWithinOneWord,
    /// clamped to the tick range the way the V3 pool clamps it.
    function _nextWordBoundary(int24 current, bool lte) internal view returns (int24 next) {
        unchecked {
            int24 compressed = current / tickSpacing;
            if (current < 0 && current % tickSpacing != 0) --compressed;
            if (lte) {
                // forge-lint: disable-next-line(unsafe-typecast)
                uint8 bitPos = uint8(int8(compressed % 256));
                next = (compressed - int24(uint24(bitPos))) * tickSpacing;
                if (next < TickMath.MIN_TICK) next = TickMath.MIN_TICK;
            } else {
                // forge-lint: disable-next-line(unsafe-typecast)
                uint8 bitPos = uint8(int8((compressed + 1) % 256));
                next = (compressed + 1 + int24(uint24(type(uint8).max - bitPos))) * tickSpacing;
                if (next > TickMath.MAX_TICK) next = TickMath.MAX_TICK;
            }
        }
    }

    /// @dev Writes at most one observation per block. The cumulative is closed off
    /// at the old tick before the new one takes over.
    function _move(uint160 nextPrice, int24 nextTick) internal {
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 now_ = uint32(block.timestamp);

        if (observationCount == 0) {
            observations[0] = Observation(now_, 0, nextTick);
            observationCount = 1;
        } else if (nextTick != tick) {
            Observation memory last = observations[observationIndex];
            int56 cumulative = last.tickCumulative + int56(last.tick) * int56(uint56(now_ - last.timestamp));
            if (last.timestamp == now_) {
                observations[observationIndex].tick = nextTick;
            } else {
                observationIndex = (observationIndex + 1) % CARDINALITY;
                observations[observationIndex] = Observation(now_, cumulative, nextTick);
                if (observationCount < CARDINALITY) ++observationCount;
            }
        }

        sqrtPriceX96 = nextPrice;
        tick = nextTick;
    }

    /// @dev Newest first, so a window of a few rounds costs a few reads.
    function _cumulativeAt(uint32 target) internal view returns (int56) {
        uint16 index = observationIndex;
        for (uint16 seen = 0; seen < observationCount; ++seen) {
            Observation memory o = observations[index];
            if (o.timestamp <= target) {
                return o.tickCumulative + int56(o.tick) * int56(uint56(target - o.timestamp));
            }
            index = index == 0 ? CARDINALITY - 1 : index - 1;
        }
        revert ObservationTooOld(target, observations[(index + 1) % CARDINALITY].timestamp);
    }
}
