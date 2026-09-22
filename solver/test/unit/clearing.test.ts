import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {allocate, clear, inBand, legsOf, pairsOf, volumeAt, type Reference} from "../../src/clearing.ts";
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
