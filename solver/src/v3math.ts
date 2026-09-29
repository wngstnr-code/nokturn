// UniswapV3Adapter.quoteWithStats, ported to TypeScript for replay and
// analytics, where one eth_call per quote is too slow. The production path
// stays the eth_call in baseline.ts, because that one is exact by construction.
// This one is exact only by test, test/fork/v3math.test.ts, zero difference
// against the deployed adapter at the pinned block. docs/desain-baseline.md 9.
//
// Ported from the code that runs, contracts/src/adapters/UniswapV3Adapter.sol
// and the v4-core libraries it calls, not from the pseudocode in section 4.
// BigInt never overflows, so every place those libraries rely on unchecked
// 256 bit wrapping is wrapped by hand, and each one is marked.

const Q96 = 1n << 96n;
const U256 = 1n << 256n;
const U128 = 1n << 128n;
const MAX_SWAP_FEE = 1_000_000n;
const DYNAMIC_FEE_FLAG = 0x800000;
const MAX_TICK_CROSSINGS = 32;
const MAX_LOOP_STEPS = 128;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/** Carries the contract's error name, so a caller can compare reverts too. */
export class QuoteError extends Error {
  readonly errorName: string;
  constructor(errorName: string, detail: string) {
    super(`${errorName}(${detail})`);
    this.errorName = errorName;
  }
}

function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  const r = (a * b) / d;
  if (r >= U256) throw new QuoteError("FullMathOverflow", `${a}, ${b}, ${d}`);
  return r;
}

function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
  const r = mulDiv(a, b, d);
  return (a * b) % d > 0n ? r + 1n : r;
}

const divRoundingUp = (x: bigint, y: bigint) => x / y + (x % y > 0n ? 1n : 0n);

export function getSqrtPriceAtTick(tick: number): bigint {
  const absTick = BigInt(Math.abs(tick));
  if (absTick > BigInt(MAX_TICK)) throw new QuoteError("InvalidTick", String(tick));
  let price = (absTick & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  const steps: [bigint, bigint][] = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, factor] of steps) if ((absTick & bit) !== 0n) price = (price * factor) >> 128n;
  if (tick > 0) price = (U256 - 1n) / price;
  return (price + (1n << 32n) - 1n) >> 32n;
}

/**
 * The greatest tick whose sqrt price does not exceed the input, which is the
 * definition v4-core's log2 approximation resolves to in its last line. Found
 * by binary search over the ported getSqrtPriceAtTick, so the two cannot differ.
 */
export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) throw new QuoteError("InvalidSqrtPrice", String(sqrtPriceX96));
  let lo = MIN_TICK;
  let hi = MAX_TICK - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (getSqrtPriceAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function getAmount0Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (a > b) [a, b] = [b, a];
  if (a === 0n) throw new QuoteError("InvalidPrice", "");
  const numerator1 = liquidity << 96n;
  const numerator2 = b - a;
  return roundUp ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, b), a) : mulDiv(numerator1, numerator2, b) / a;
}

function getAmount1Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const diff = a > b ? a - b : b - a;
  const amount = mulDiv(liquidity, diff, Q96);
  return roundUp && (liquidity * diff) % Q96 > 0n ? amount + 1n : amount;
}

function nextFromAmount0RoundingUp(sqrtP: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtP;
  const numerator1 = liquidity << 96n;
  // unchecked in v4-core. The product wraps at 2^256, and the wrap is what
  // sends it down the fallback branch.
  const product = (amount * sqrtP) % U256;
  if (product / amount === sqrtP) {
    const denominator = (numerator1 + product) % U256;
    if (denominator >= numerator1) return mulDivRoundingUp(numerator1, sqrtP, denominator);
  }
  return divRoundingUp(numerator1, numerator1 / sqrtP + amount);
}

function nextFromAmount1RoundingDown(sqrtP: bigint, liquidity: bigint, amount: bigint): bigint {
  const quotient = amount <= (1n << 160n) - 1n ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity);
  const next = sqrtP + quotient;
  if (next >= 1n << 160n) throw new QuoteError("SafeCastOverflow", String(next));
  return next;
}

function nextFromInput(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (sqrtP === 0n || liquidity === 0n) throw new QuoteError("InvalidPriceOrLiquidity", "");
  return zeroForOne ? nextFromAmount0RoundingUp(sqrtP, liquidity, amountIn) : nextFromAmount1RoundingDown(sqrtP, liquidity, amountIn);
}

/** v4-core SwapMath.computeSwapStep, exact input only, which is the only way the adapter calls it. */
export function computeSwapStepExactIn(
  sqrtCurrent: bigint,
  sqrtTarget: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: bigint,
): {sqrtNext: bigint; amountIn: bigint; amountOut: bigint; feeAmount: bigint} {
  const zeroForOne = sqrtCurrent >= sqrtTarget;
  const lessFee = mulDiv(amountRemaining, MAX_SWAP_FEE - feePips, MAX_SWAP_FEE);
  let amountIn = zeroForOne ? getAmount0Delta(sqrtTarget, sqrtCurrent, liquidity, true) : getAmount1Delta(sqrtCurrent, sqrtTarget, liquidity, true);
  let sqrtNext: bigint;
  let feeAmount: bigint;
  if (lessFee >= amountIn) {
    sqrtNext = sqrtTarget;
    feeAmount = feePips === MAX_SWAP_FEE ? amountIn : mulDivRoundingUp(amountIn, feePips, MAX_SWAP_FEE - feePips);
  } else {
    amountIn = lessFee;
    sqrtNext = nextFromInput(sqrtCurrent, liquidity, lessFee, zeroForOne);
    feeAmount = amountRemaining - amountIn;
  }
  const amountOut = zeroForOne ? getAmount1Delta(sqrtNext, sqrtCurrent, liquidity, false) : getAmount0Delta(sqrtCurrent, sqrtNext, liquidity, false);
  return {sqrtNext, amountIn, amountOut, feeAmount};
}

export interface PoolState {
  pool: string;
  sqrtPriceX96: bigint;
  tick: number;
  fee: number;
  tickSpacing: number;
  liquidity: bigint;
}

/** The two things the loop reads from the pool as it goes. */
export interface PoolReads {
  tickBitmap(wordPos: number): Promise<bigint>;
  liquidityNet(tick: number): Promise<bigint>;
}

const msb = (x: bigint) => x.toString(2).length - 1;
const lsb = (x: bigint) => msb(x & -x);

/** Solidity's truncating division for int24, which rounds toward zero. */
const tdiv = (a: number, b: number) => Math.trunc(a / b);

async function nextInitializedTick(reads: PoolReads, tick: number, spacing: number, lte: boolean): Promise<{next: number; initialized: boolean}> {
  let compressed = tdiv(tick, spacing);
  if (tick < 0 && tick % spacing !== 0) compressed -= 1;
  // int16(t >> 8) is a floor, and uint8(int8(t % 256)) is t mod 256 taken
  // non negative. The int8 cast in between is what makes negative ticks land in
  // the right bit, and GME sits at a negative tick. desain-baseline.md 9.2.
  const position = (t: number) => ({wordPos: Math.floor(t / 256), bitPos: ((t % 256) + 256) % 256});
  if (lte) {
    const {wordPos, bitPos} = position(compressed);
    const mask = (1n << BigInt(bitPos)) - 1n + (1n << BigInt(bitPos));
    const masked = (await reads.tickBitmap(wordPos)) & mask;
    const initialized = masked !== 0n;
    const next = initialized ? (compressed - (bitPos - msb(masked))) * spacing : (compressed - bitPos) * spacing;
    return {next, initialized};
  }
  const {wordPos, bitPos} = position(compressed + 1);
  const mask = (U256 - 1n) ^ ((1n << BigInt(bitPos)) - 1n);
  const masked = (await reads.tickBitmap(wordPos)) & mask;
  const initialized = masked !== 0n;
  const next = initialized ? (compressed + 1 + (lsb(masked) - bitPos)) * spacing : (compressed + 1 + (255 - bitPos)) * spacing;
  return {next, initialized};
}

/** LiquidityMath.addDelta as the adapter restates it, unchecked, so it wraps at 2^128. */
const applyLiquidity = (liquidity: bigint, delta: bigint) => (((liquidity + delta) % U128) + U128) % U128;

export async function quoteExactIn(
  state: PoolState,
  zeroForOne: boolean,
  amountIn: bigint,
  reads: PoolReads,
): Promise<{amountOut: bigint; crossings: number; steps: number}> {
  if (state.sqrtPriceX96 === 0n) throw new QuoteError("PoolNotInitialized", state.pool);
  if (state.fee >= DYNAMIC_FEE_FLAG) throw new QuoteError("DynamicFeeUnsupported", state.pool);

  let {sqrtPriceX96, tick, liquidity} = state;
  const feePips = BigInt(state.fee);
  let remaining = amountIn;
  let amountOut = 0n;
  let crossings = 0;
  let steps = 0;

  for (; steps < MAX_LOOP_STEPS && remaining > 0n; steps += 1) {
    const {next, initialized} = await nextInitializedTick(reads, tick, state.tickSpacing, zeroForOne);
    const sqrtTarget = getSqrtPriceAtTick(next);
    const step = computeSwapStepExactIn(sqrtPriceX96, sqrtTarget, liquidity, remaining, feePips);
    remaining -= step.amountIn + step.feeAmount;
    amountOut += step.amountOut;
    sqrtPriceX96 = step.sqrtNext;

    if (step.sqrtNext === sqrtTarget) {
      if (initialized) {
        const net = await reads.liquidityNet(next);
        liquidity = applyLiquidity(liquidity, zeroForOne ? -net : net);
        crossings += 1;
        if (crossings > MAX_TICK_CROSSINGS) throw new QuoteError("TooManyTickCrossings", `${state.pool}, ${crossings}`);
        if (liquidity === 0n) throw new QuoteError("LiquidityExhausted", `${state.pool}, ${remaining}`);
      }
      tick = zeroForOne ? next - 1 : next;
    } else {
      tick = getTickAtSqrtPrice(step.sqrtNext);
    }
  }

  if (remaining !== 0n) throw new QuoteError("LiquidityExhausted", `${state.pool}, ${remaining}`);
  return {amountOut, crossings, steps};
}
