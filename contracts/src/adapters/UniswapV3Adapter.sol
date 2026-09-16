// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BitMath} from "v4-core/libraries/BitMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {SwapMath} from "v4-core/libraries/SwapMath.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";
import {IVenueAdapter} from "../interfaces/IVenueAdapter.sol";

/// @title Uniswap V3 baseline adapter
/// @notice Recomputes the swap from pool state instead of quoting it. The Uniswap
/// Quoter runs the swap and reverts, which means it tries to SSTORE, and STATICCALL
/// refuses any state write. Verified, see pertanyaan-terbuka.md P1-1.
///
/// Factory agnostic by design. Pools are allowlisted one by one, so the V3 style
/// venues that are byte identical on this chain join through the timelock without
/// new code. See CLAUDE.md section 2 rule 4.
contract UniswapV3Adapter is IVenueAdapter {
    using SafeERC20 for IERC20;

    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    uint256 internal constant Q96 = 1 << 96;

    /// parameter.md section 4B. Both are provisional and must be replaced by the
    /// measured p99 from the fork tests before they are trusted.
    uint16 internal constant MAX_TICK_CROSSINGS = 32;
    uint16 internal constant MAX_LOOP_STEPS = 128;

    address public immutable governor;

    /// Keyed by the pool's own token0 and token1, never by an assumption about
    /// which side USDG sits on. It is token0 for NVDA and AAPL and token1 for TSLA
    /// and GOOGL on this chain, measured 16 September 2026.
    mapping(address => mapping(address => address)) public poolFor;

    error NotGovernor();
    error PoolNotSet(address tokenIn, address tokenOut);

    event PoolSet(address indexed tokenA, address indexed tokenB, address pool, uint24 fee);

    constructor(address governor_) {
        governor = governor_;
    }

    function setPool(address pool) external {
        if (msg.sender != governor) revert NotGovernor();

        IUniswapV3Pool p = IUniswapV3Pool(pool);
        (uint160 sqrtPriceX96,,,,,,) = p.slot0();
        if (sqrtPriceX96 == 0) revert PoolNotInitialized(pool);

        uint24 fee = p.fee();
        if (fee >= DYNAMIC_FEE_FLAG) revert DynamicFeeUnsupported(pool);

        address token0 = p.token0();
        address token1 = p.token1();
        poolFor[token0][token1] = pool;
        poolFor[token1][token0] = pool;

        emit PoolSet(token0, token1, pool, fee);
    }

    /// @inheritdoc IVenueAdapter
    function isQuotable() external pure returns (bool) {
        return true;
    }

    /// @inheritdoc IVenueAdapter
    function quoteFromState(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 amountOut)
    {
        (amountOut,,) = quoteWithStats(tokenIn, tokenOut, amountIn);
    }

    /// @notice Same quote, with the loop counters exposed. MAX_TICK_CROSSINGS has
    /// to be calibrated from measured crossings rather than guessed, and a number
    /// nobody can read back is a number nobody can calibrate.
    function quoteWithStats(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, uint16 crossings, uint16 steps)
    {
        IUniswapV3Pool pool = IUniswapV3Pool(_pool(tokenIn, tokenOut));

        (uint160 sqrtPriceX96, int24 tick,,,,,) = pool.slot0();
        if (sqrtPriceX96 == 0) revert PoolNotInitialized(address(pool));

        uint24 feePips = pool.fee();
        if (feePips >= DYNAMIC_FEE_FLAG) revert DynamicFeeUnsupported(address(pool));

        bool zeroForOne = tokenIn == pool.token0();
        int24 spacing = pool.tickSpacing();
        uint128 liquidity = pool.liquidity();

        uint256 remaining = amountIn;

        for (; steps < MAX_LOOP_STEPS && remaining > 0; ++steps) {
            (int24 nextTick, bool initialized) = _nextInitializedTick(pool, tick, spacing, zeroForOne);
            uint160 sqrtTarget = TickMath.getSqrtPriceAtTick(nextTick);

            // Negative means exact input in the v4-core SwapMath, and remaining is
            // bounded by the caller's amountIn.
            // forge-lint: disable-next-line(unsafe-typecast)
            int256 exactIn = -int256(remaining);
            (uint160 sqrtNext, uint256 stepIn, uint256 stepOut, uint256 stepFee) =
                SwapMath.computeSwapStep(sqrtPriceX96, sqrtTarget, liquidity, exactIn, feePips);

            remaining -= (stepIn + stepFee);
            amountOut += stepOut;
            sqrtPriceX96 = sqrtNext;

            if (sqrtNext == sqrtTarget) {
                if (initialized) {
                    (, int128 liquidityNet,,,,,,) = pool.ticks(nextTick);
                    liquidity = zeroForOne
                        ? _applyLiquidity(liquidity, -liquidityNet)
                        : _applyLiquidity(liquidity, liquidityNet);

                    // A word boundary step is not a liquidity crossing. Counting it
                    // as one would trip the limit long before any real crossing.
                    ++crossings;
                    if (crossings > MAX_TICK_CROSSINGS) {
                        revert TooManyTickCrossings(address(pool), crossings);
                    }
                    if (liquidity == 0) revert LiquidityExhausted(address(pool), remaining);
                }
                tick = zeroForOne ? nextTick - 1 : nextTick;
            } else {
                tick = TickMath.getTickAtSqrtPrice(sqrtNext);
            }
        }

        // Never return a partial result. A wrong baseline makes the fee wrong and
        // the savings claim false. No baseline only makes the batch a pass through.
        if (remaining != 0) revert LiquidityExhausted(address(pool), remaining);
    }

    /// @inheritdoc IVenueAdapter
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut)
    {
        IUniswapV3Pool pool = IUniswapV3Pool(_pool(tokenIn, tokenOut));
        bool zeroForOne = tokenIn == pool.token0();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        (int256 amount0, int256 amount1) = pool.swap(
            msg.sender,
            zeroForOne,
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(amountIn),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            abi.encode(tokenIn)
        );

        int256 delta = zeroForOne ? amount1 : amount0;
        // The pool returns what it owes the recipient as a negative delta.
        // forge-lint: disable-next-line(unsafe-typecast)
        amountOut = uint256(-delta);
        if (amountOut < minOut) revert LiquidityExhausted(address(pool), minOut - amountOut);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address tokenIn = abi.decode(data, (address));
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);

        // Only a pool this adapter already knows can ask it for money.
        address other = tokenIn == pool.token0() ? pool.token1() : pool.token0();
        if (poolFor[tokenIn][other] != msg.sender) revert PoolNotSet(tokenIn, other);

        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(tokenIn).safeTransfer(msg.sender, owed);
    }

    /// @inheritdoc IVenueAdapter
    /// @return price tokenOut per one whole tokenIn, scaled to 1e18.
    /// The pool works in raw units, so the decimal difference is applied here and
    /// only here. USDG has 6 decimals against 18 on every Stock Token, and reading
    /// that ratio raw gives a number that looks plausible and is wrong by 1e12.
    function twap(address tokenIn, address tokenOut, uint32 window) external view returns (uint256 price) {
        IUniswapV3Pool pool = IUniswapV3Pool(_pool(tokenIn, tokenOut));

        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        ago[1] = 0;
        (int56[] memory cumulatives,) = pool.observe(ago);

        int56 delta = cumulatives[1] - cumulatives[0];
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 meanTick = int24(delta / int56(uint56(window)));
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) --meanTick;

        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(meanTick);
        uint256 priceX96 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, Q96);

        uint256 scale =
            10 ** IERC20Metadata(tokenIn).decimals() * 10 ** (18 - IERC20Metadata(tokenOut).decimals());

        price = tokenIn == pool.token0()
            ? FullMath.mulDiv(priceX96, scale, Q96)
            : FullMath.mulDiv(scale, Q96, priceX96);
    }

    function _pool(address tokenIn, address tokenOut) internal view returns (address pool) {
        pool = poolFor[tokenIn][tokenOut];
        if (pool == address(0)) revert PoolNotSet(tokenIn, tokenOut);
    }

    /// @dev The v4-core helper reads its own storage mapping. This one reads the
    /// pool's bitmap through an external call, so the word arithmetic is repeated
    /// here while the bit search itself still comes from BitMath.
    function _nextInitializedTick(IUniswapV3Pool pool, int24 tick, int24 tickSpacing, bool lte)
        internal
        view
        returns (int24 next, bool initialized)
    {
        unchecked {
            int24 compressed = tick / tickSpacing;
            if (tick < 0 && tick % tickSpacing != 0) --compressed;

            if (lte) {
                (int16 wordPos, uint8 bitPos) = _position(compressed);
                // All bits at or to the right of bitPos, exactly as TickBitmap does.
                // forge-lint: disable-next-line(incorrect-shift)
                uint256 mask = (1 << bitPos) - 1 + (1 << bitPos);
                uint256 masked = pool.tickBitmap(wordPos) & mask;

                initialized = masked != 0;
                next = initialized
                    ? (compressed - int24(uint24(bitPos - BitMath.mostSignificantBit(masked)))) * tickSpacing
                    : (compressed - int24(uint24(bitPos))) * tickSpacing;
            } else {
                (int16 wordPos, uint8 bitPos) = _position(compressed + 1);
                // All bits at or to the left of bitPos.
                // forge-lint: disable-next-line(incorrect-shift)
                uint256 mask = ~((1 << bitPos) - 1);
                uint256 masked = pool.tickBitmap(wordPos) & mask;

                initialized = masked != 0;
                next = initialized
                    ? (compressed + 1 + int24(uint24(BitMath.leastSignificantBit(masked) - bitPos)))
                        * tickSpacing
                    : (compressed + 1 + int24(uint24(type(uint8).max - bitPos))) * tickSpacing;
            }
        }
    }

    function _position(int24 tick) internal pure returns (int16 wordPos, uint8 bitPos) {
        unchecked {
            // forge-lint: disable-next-line(unsafe-typecast)
            wordPos = int16(tick >> 8);
            // forge-lint: disable-next-line(unsafe-typecast)
            bitPos = uint8(int8(tick % 256));
        }
    }

    /// @dev LiquidityMath.addDelta from v3-core, restated because the sign flip on
    /// the way down has to wrap the same way the pool wraps it.
    function _applyLiquidity(uint128 liquidity, int128 delta) internal pure returns (uint128) {
        unchecked {
            // forge-lint: disable-next-line(unsafe-typecast)
            return delta < 0 ? liquidity - uint128(-delta) : uint128(delta) + liquidity;
        }
    }
}
