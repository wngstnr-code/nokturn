import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {clear, inBand, legsOf, pairsOf, volumeAt, type Reference} from "../../src/clearing.ts";
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
