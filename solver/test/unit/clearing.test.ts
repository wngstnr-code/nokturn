import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {allocate, clear, inBand, legsOf, pairsOf, route, volumeAt, type Reference} from "../../src/clearing.ts";
import {WAD, conservation, limitRespected, uniformPriceHolds} from "../../src/math.ts";
import {PARTIAL_FILL, type Intent} from "../../src/solution.ts";
import {NVDA, OWNER_A, QUOTE, TSLA, intent, rng} from "./fixtures.ts";

// Unit prices for a six decimal quote at one dollar and an eighteen decimal base.
const ONE_DOLLAR_QUOTE = 10n ** 30n;
const dollars = (x: bigint) => x * 10n ** 18n;
/** Pair price of a base token at x dollars against a one dollar quote. */
const pairAt = (x: bigint) => x * 10n ** 6n;

function buyer(qtyWhole: bigint, limitDollars: bigint, flags = 0): Intent {
  return intent({sellToken: QUOTE, buyToken: NVDA, sellAmount: qtyWhole * limitDollars * 10n ** 6n, minBuyAmount: qtyWhole * 10n ** 18n, flags});
}
function seller(qtyWhole: bigint, limitDollars: bigint, flags = 0): Intent {
  return intent({sellToken: NVDA, buyToken: QUOTE, sellAmount: qtyWhole * 10n ** 18n, minBuyAmount: qtyWhole * limitDollars * 10n ** 6n, flags});
}

/** desain-kliring.md section 4.1, with the reference at 177.2 dollars. */
function bookOf41(flags = 0) {
  const intents = [buyer(100n, 180n, flags), buyer(50n, 178n, flags), buyer(80n, 176n, flags), seller(60n, 175n), seller(70n, 177n), seller(90n, 179n)];
  const ref: Reference = {quotePrice: ONE_DOLLAR_QUOTE, basePrice: 1772n * 10n ** 17n, maxDeviationBps: 500n};
  return {intents, ref, pair: pairsOf(intents, QUOTE).pairs[0]!};
}

describe("F16 clearing price", () => {
  test("volumeAt reproduces the table in desain-kliring.md 4.1", () => {
    const {pair} = bookOf41();
    const table = [175n, 176n, 177n, 178n, 179n, 180n].map((x) => volumeAt(legsOf(pair), pairAt(x)).executable / 10n ** 18n);
    assert.deepEqual(table, [60n, 60n, 130n, 130n, 100n, 100n]);
  });

  // The document picks 177 because its candidates are the limits alone. The
  // reference is a candidate here too, it sits on the same plateau of volume and
  // imbalance, and the third rule then prefers it to either limit.
  test("the plateau between 177 and 178 resolves to the price nearest the reference", () => {
    const {pair, ref} = bookOf41();
    const c = clear(pair, ref)!;
    assert.equal(c.price, 1772n * 10n ** 5n);
    assert.deepEqual(volumeAt(legsOf(pair), c.price), volumeAt(legsOf(pair), pairAt(177n)));
    assert.equal(c.demand, 150n * 10n ** 18n);
    assert.equal(c.supply, 130n * 10n ** 18n);
    assert.equal(c.executable, 130n * 10n ** 18n);
  });

  test("the chosen price is always inside the band", () => {
    const {pair} = bookOf41();
    const tight: Reference = {quotePrice: ONE_DOLLAR_QUOTE, basePrice: dollars(179n), maxDeviationBps: 20n};
    const c = clear(pair, tight)!;
    assert.equal(inBand(c.price, tight), true);
    assert.equal(c.executable, 100n * 10n ** 18n);
  });

  test("limits far outside the band still clear at the band edge", () => {
    const intents = [buyer(10n, 300n), seller(10n, 100n)];
    const ref: Reference = {quotePrice: ONE_DOLLAR_QUOTE, basePrice: dollars(200n), maxDeviationBps: 150n};
    const c = clear(pairsOf(intents, QUOTE).pairs[0]!, ref)!;
    assert.equal(inBand(c.price, ref), true);
    assert.equal(c.executable > 0n, true);
  });

  test("an intent between two base tokens is set aside, not cleared", () => {
    const {pairs, unsupported} = pairsOf([buyer(1n, 1n), intent({sellToken: NVDA, buyToken: TSLA, sellAmount: 1n, minBuyAmount: 1n})], QUOTE);
    assert.equal(pairs.length, 1);
    assert.deepEqual(unsupported, [1]);
  });
});

describe("F17 rationing on the 4.1 book", () => {
  test("partial buyers share the short side pro rata and B3 does not trade", () => {
    const {pair, ref} = bookOf41(PARTIAL_FILL);
    const c = clear(pair, ref)!;
    const a = allocate(pair, c, ref);
    const byIndex = new Map(a.fills.map((f) => [f.index, f]));
    assert.equal(byIndex.has(2), false, "B3 is below the clearing price");
    assert.equal(byIndex.get(3)!.executedSell, 60n * 10n ** 18n);
    assert.equal(byIndex.get(4)!.executedSell, 70n * 10n ** 18n);
    const b1 = byIndex.get(0)!.executedBuy;
    const b2 = byIndex.get(1)!.executedBuy;
    assert.equal(b1 + b2 <= 130n * 10n ** 18n, true);
    // Pro rata to each one's size at the clearing price, so b1/s1 equals b2/s2
    // up to the one unit each floor can take.
    const size = (k: number) => (pair.entries[k]!.intent.sellAmount * a.quotePrice) / a.basePrice;
    const skew = b1 * size(1) - b2 * size(0);
    const magnitude = skew < 0n ? -skew : skew;
    assert.ok(magnitude <= size(0) + size(1), `b1 ${b1} b2 ${b2} skew ${skew}`);
  });

  test("without PARTIAL_FILL a buyer trades completely or not at all", () => {
    const {pair, ref} = bookOf41(0);
    const a = allocate(pair, clear(pair, ref)!, ref);
    for (const f of a.fills) {
      const i = pair.entries.find((e) => e.index === f.index)!.intent;
      assert.equal(f.executedSell, i.sellAmount);
    }
  });
});

describe("F18 routing", () => {
  test("an unfilled whole buyer leaves base over, which is sold for the quote the sellers are owed", () => {
    const {pair, ref} = bookOf41(0);
    const a = allocate(pair, clear(pair, ref)!, ref);
    const r = route(pair, a.fills, OWNER_A, (need) => need.needOut);
    assert.equal(r.venueCalls.length, 1);
    assert.equal(r.venueCalls[0]!.tokenIn, NVDA);
    assert.equal(r.venueCalls[0]!.tokenOut, QUOTE);
  });

  test("a minOut below what the batch needs back is refused", () => {
    const {pair, ref} = bookOf41(0);
    const a = allocate(pair, clear(pair, ref)!, ref);
    assert.throws(() => route(pair, a.fills, OWNER_A, (need) => need.needOut - 1n), /ValueNotConserved/);
  });
});

/** A random book around a random price, with limits a few percent either side. */
function randomCase(seed: number) {
  const r = rng(seed);
  const priceMicro = BigInt(r.int(20, 900)) * 1_000_000n;
  const quotePrice = (ONE_DOLLAR_QUOTE * BigInt(1_000_000 + r.int(-500, 500))) / 1_000_000n;
  const basePrice = (priceMicro * 10n ** 12n * BigInt(1_000_000 + r.int(-20_000, 20_000))) / 1_000_000n;
  const ref: Reference = {quotePrice, basePrice, maxDeviationBps: [150n, 300n, 500n][r.int(0, 2)]!};
  const n = r.int(1, 12);
  const intents: Intent[] = [];
  for (let k = 0; k < n; k += 1) {
    const limitMicro = (priceMicro * BigInt(10_000 + r.int(-400, 400))) / 10_000n;
    const flags = r.bool() ? PARTIAL_FILL : 0;
    if (r.bool()) {
      const sellAmount = r.big(1_000_000n, 5_000_000_000n);
      intents.push(intent({sellToken: QUOTE, buyToken: NVDA, sellAmount, minBuyAmount: (sellAmount * 10n ** 18n) / limitMicro, flags, nonce: BigInt(k)}));
    } else {
      const sellAmount = r.big(10n ** 15n, 50n * 10n ** 18n);
      intents.push(intent({sellToken: NVDA, buyToken: QUOTE, sellAmount, minBuyAmount: (sellAmount * limitMicro) / 10n ** 18n, flags, nonce: BigInt(k)}));
    }
  }
  return {intents, ref};
}

function settle(intents: Intent[], ref: Reference) {
  const pair = pairsOf(intents, QUOTE).pairs[0];
  if (!pair) return null;
  const c = clear(pair, ref);
  if (!c) return null;
  const a = allocate(pair, c, ref);
  const r = route(pair, a.fills, OWNER_A, (need) => need.needOut);
  const tokens = [QUOTE, NVDA];
  const executions = a.fills.map((f) => ({intentIndex: BigInt(f.index), executedSell: f.executedSell, executedBuy: f.executedBuy}));
  return {pair, c, a, r, tokens, executions};
}

describe("properties over 500 seeded books", () => {
  const SEEDS = Array.from({length: 500}, (_, k) => 7919 * (k + 1));

  test("users never receive more than the batch has, and both tokens stay conserved", () => {
    for (const seed of SEEDS) {
      const {intents, ref} = randomCase(seed);
      const out = settle(intents, ref);
      if (!out) continue;
      let baseIn = 0n;
      let baseOut = 0n;
      for (const f of out.a.fills) {
        const i = intents[f.index]!;
        if (i.sellToken === QUOTE) baseOut += f.executedBuy;
        else baseIn += f.executedSell;
      }
      const venueBase = out.r.venueCalls.filter((v) => v.tokenOut === NVDA).reduce((s, v) => s + v.minOut, 0n);
      assert.equal(baseOut <= baseIn + venueBase, true, `seed ${seed}`);
      const bal = conservation({intents, executions: out.executions, venueCalls: out.r.venueCalls, tokens: out.tokens});
      assert.equal(bal.every((b) => b >= 0n), true, `seed ${seed} balance ${bal}`);
    }
  });

  test("every execution respects its limit, the uniform price, and the band", () => {
    for (const seed of SEEDS) {
      const {intents, ref} = randomCase(seed);
      const out = settle(intents, ref);
      if (!out) continue;
      assert.equal(inBand(out.c.price, ref), true, `seed ${seed}`);
      for (const f of out.a.fills) {
        const i = intents[f.index]!;
        const buys = i.sellToken === QUOTE;
        assert.equal(f.executedSell <= i.sellAmount, true, `seed ${seed}`);
        assert.equal(limitRespected(f.executedBuy, i.sellAmount, i.minBuyAmount, f.executedSell), true, `seed ${seed} intent ${f.index}`);
        const quotePrice: bigint = out.a.quotePrice;
        const basePrice: bigint = out.a.basePrice;
        const [sp, bp] = buys ? [quotePrice, basePrice] : [basePrice, quotePrice];
        assert.equal(uniformPriceHolds(f.executedSell, f.executedBuy, sp, bp), true, `seed ${seed} intent ${f.index}`);
      }
    }
  });

  test("an intent without PARTIAL_FILL fills completely or not at all", () => {
    for (const seed of SEEDS) {
      const {intents, ref} = randomCase(seed);
      const out = settle(intents, ref);
      if (!out) continue;
      for (const f of out.a.fills) {
        const i = intents[f.index]!;
        if ((i.flags & PARTIAL_FILL) === 0) assert.equal(f.executedSell, i.sellAmount, `seed ${seed} intent ${f.index}`);
      }
    }
  });

  // Every buyer and seller has its limit exactly at one price, so that is the
  // only price with volume, and the two sides are sized to meet there exactly.
  test("a balanced two sided batch needs no venue call", () => {
    const p0 = pairAt(200n);
    const ref: Reference = {quotePrice: ONE_DOLLAR_QUOTE, basePrice: dollars(200n), maxDeviationBps: 300n};
    for (const seed of SEEDS) {
      const r = rng(seed);
      const buys = Array.from({length: r.int(1, 6)}, () => r.big(1n, 2_000_000_000n));
      const total = buys.reduce((a, b) => a + b, 0n);
      const cuts = Array.from({length: r.int(1, 6) - 1}, () => r.big(0n, total)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const sells = [...cuts, total].map((c, k, all) => c - (k === 0 ? 0n : all[k - 1]!)).filter((x) => x > 0n);
      const intents: Intent[] = [
        ...buys.map((q) => intent({sellToken: QUOTE, buyToken: NVDA, sellAmount: q, minBuyAmount: (q * WAD) / p0, flags: r.bool() ? PARTIAL_FILL : 0})),
        ...sells.map((x) => intent({sellToken: NVDA, buyToken: QUOTE, sellAmount: (x * WAD * WAD) / p0 / WAD, minBuyAmount: x, flags: r.bool() ? PARTIAL_FILL : 0})),
      ];
      const out = settle(intents, ref)!;
      assert.equal(out.c.price, p0, `seed ${seed}`);
      assert.equal(out.a.fills.length, intents.length, `seed ${seed} excluded ${JSON.stringify(out.a.excluded)}`);
      assert.equal(out.r.venueCalls.length, 0, `seed ${seed} residual ${out.r.residual.base} ${out.r.residual.quote}`);
    }
  });
});
