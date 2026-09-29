import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  QuoteError,
  computeSwapStepExactIn,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  quoteExactIn,
  type PoolReads,
} from "../../src/v3math.ts";
import {rng} from "./fixtures.ts";

// The fork test is the gate. These only pin what can be pinned without a chain,
// the bounds v4-core states as constants and the properties any swap must have.

describe("TickMath port", () => {
  test("the bounds are the constants v4-core declares", () => {
    assert.equal(getSqrtPriceAtTick(0), 1n << 96n);
    assert.equal(getSqrtPriceAtTick(MIN_TICK), MIN_SQRT_PRICE);
    assert.equal(getSqrtPriceAtTick(MAX_TICK), MAX_SQRT_PRICE);
    assert.throws(() => getSqrtPriceAtTick(MAX_TICK + 1), (e: unknown) => e instanceof QuoteError && e.errorName === "InvalidTick");
    assert.equal(getTickAtSqrtPrice(MIN_SQRT_PRICE), MIN_TICK);
    assert.equal(getTickAtSqrtPrice(MAX_SQRT_PRICE - 1n), MAX_TICK - 1);
    assert.throws(() => getTickAtSqrtPrice(MAX_SQRT_PRICE), (e: unknown) => e instanceof QuoteError && e.errorName === "InvalidSqrtPrice");
  });

  test("tick to price and back, and one unit below lands on the tick before", () => {
    const r = rng(4663);
    for (let n = 0; n < 300; n += 1) {
      const t = r.int(MIN_TICK + 1, MAX_TICK - 1);
      const p = getSqrtPriceAtTick(t);
      assert.equal(getTickAtSqrtPrice(p), t);
      assert.equal(getTickAtSqrtPrice(p - 1n), t - 1);
      assert.ok(getSqrtPriceAtTick(t + 1) > p);
    }
  });
});

describe("the quote loop", () => {
  // One range of liquidity with nothing initialized, so every step ends at a word boundary.
  const flat: PoolReads = {tickBitmap: async () => 0n, liquidityNet: async () => 0n};
  const state = {pool: "0xpool", sqrtPriceX96: getSqrtPriceAtTick(-276_300), tick: -276_300, fee: 500, tickSpacing: 10, liquidity: 10n ** 22n};

  test("a step that exhausts the input charges the rest as fee", () => {
    // Too small to move a price rounded up, which is the direction v4-core rounds on input.
    const s = computeSwapStepExactIn(state.sqrtPriceX96, getSqrtPriceAtTick(-276_310), state.liquidity, 1_000n, 500n);
    assert.ok(s.sqrtNext <= state.sqrtPriceX96);
    assert.equal(s.amountIn + s.feeAmount, 1_000n);
  });

  test("more in never gives less out, in both directions, until the step limit refuses", async () => {
    for (const zeroForOne of [true, false]) {
      let last = -1n;
      let quoted = 0;
      for (let amount = 1_000n; amount < 10n ** 30n; amount *= 7n) {
        let amountOut: bigint;
        try {
          ({amountOut} = await quoteExactIn(state, zeroForOne, amount, flat));
        } catch (e) {
          // 128 steps of one empty word each is where the adapter stops too.
          assert.ok(e instanceof QuoteError && e.errorName === "LiquidityExhausted");
          break;
        }
        assert.ok(amountOut >= last, `${amount} gave ${amountOut}, less than ${last}`);
        last = amountOut;
        quoted += 1;
      }
      assert.ok(quoted >= 10, `only ${quoted} sizes quoted ${zeroForOne ? "zero for one" : "one for zero"}`);
    }
  });

  test("an initialized tick with no liquidity past it is LiquidityExhausted, named as the adapter names it", async () => {
    const cliff: PoolReads = {
      tickBitmap: async (word) => (word === Math.floor(Math.floor(-276_300 / 10) / 256) ? 1n << BigInt((((Math.floor(-276_300 / 10) - 1) % 256) + 256) % 256) : 0n),
      liquidityNet: async () => 10n ** 22n,
    };
    await assert.rejects(quoteExactIn(state, true, 10n ** 30n, cliff), (e: unknown) => e instanceof QuoteError && e.errorName === "LiquidityExhausted");
  });

  test("a dynamic fee pool is refused before any math", async () => {
    await assert.rejects(quoteExactIn({...state, fee: 0x800000}, true, 1n, flat), (e: unknown) => e instanceof QuoteError && e.errorName === "DynamicFeeUnsupported");
  });
});
