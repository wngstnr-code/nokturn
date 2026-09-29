import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {KIND, checkCross, match, planCross, quoteOf, tokenOf, ymdOf, type BookEntry} from "../../src/cross.ts";
import {rng} from "./fixtures.ts";

const TOKEN = 10n ** 18n;
/** 180.123457 dollars per whole token, in quote units per 1e18 token units, six decimal quote. */
const ODD = 180_123_457n;

let next = 0;
function entry(buy: boolean, sellAmount: bigint, fields: Partial<BookEntry> = {}): BookEntry {
  return {index: next++, owner: `0x${next}`, buy, escrowed: true, cancelled: false, kind: KIND.MOO, maxDevFromRefBps: 0, sellAmount, limitPrice: 0n, filledSell: 0n, ...fields};
}
function book(...entries: BookEntry[]): BookEntry[] {
  next = 0;
  return entries.map((e, i) => ({...e, index: i}));
}

describe("auction cross, planned against _applyCross", () => {
  test("sellers hold more than buyers take, so buyers fill in full and sellers deliver exactly that", () => {
    const b = book(entry(false, 3n * TOKEN), entry(false, 2n * TOKEN + 12345n), entry(true, 400_000_000n), entry(true, 123_456_789n));
    const plan = planCross(b, ODD, 200, false, ODD);
    assert.ok(plan.ok, plan.ok ? "" : plan.reason);
    assert.equal(plan.price, ODD);
    const tokensToBuyers = plan.executions.filter((x) => b[Number(x.intentIndex)]!.buy).reduce((s, x) => s + x.executedBuy, 0n);
    const tokensFromSellers = plan.executions.filter((x) => !b[Number(x.intentIndex)]!.buy).reduce((s, x) => s + x.executedSell, 0n);
    assert.equal(tokensFromSellers, tokensToBuyers);
    assert.equal(tokensToBuyers, tokenOf(400_000_000n, ODD) + tokenOf(123_456_789n, ODD));
  });

  test("buyers want more than sellers hold, which is not constructible at that price, so the price rises to balance", () => {
    // Sellers hold about 360.25 dollars at ODD, buyers bring 362, so a small rise balances it.
    const b = book(entry(false, 2n * TOKEN + 777n), entry(true, 190_000_000n), entry(true, 172_000_000n));
    const atOdd = match(b, ODD, ODD, false);
    assert.ok(atOdd.demand > atOdd.supply, "the fixture must start with demand above supply");

    const plan = planCross(b, ODD, 200, false, ODD);
    assert.ok(plan.ok, plan.ok ? "" : plan.reason);
    assert.ok(plan.price > ODD);
    const m = match(b, plan.price, ODD, false);
    assert.ok(m.demand <= m.supply);
    assert.ok(match(b, plan.price - 1n, ODD, false).demand > match(b, plan.price - 1n, ODD, false).supply, "not the smallest balancing price");
    assert.equal(checkCross(b, ODD, false, plan.price, plan.executions), null);
  });

  test("an imbalance the collar cannot absorb is reported, not forced", () => {
    const b = book(entry(false, TOKEN), entry(true, 10_000_000_000n));
    const plan = planCross(b, ODD, 200, false, ODD);
    assert.equal(plan.ok, false);
  });

  test("limits hold, a buyer priced out is left out and a seller below its limit is left out", () => {
    const b = book(
      entry(false, 5n * TOKEN, {kind: KIND.LOO, limitPrice: ODD + 1_000_000n}),
      entry(false, 4n * TOKEN),
      entry(true, 200_000_000n, {kind: KIND.LOO, limitPrice: ODD - 1n}),
      entry(true, 500_000_000n),
    );
    const plan = planCross(b, ODD, 200, false, ODD);
    assert.ok(plan.ok, plan.ok ? "" : plan.reason);
    const named = plan.executions.map((x) => Number(x.intentIndex));
    assert.ok(!named.includes(0) && !named.includes(2));
  });

  test("ROO takes part only with a reference, and an excluded ROO is never executed", () => {
    const b = book(entry(false, 3n * TOKEN, {kind: KIND.ROO, maxDevFromRefBps: 100}), entry(false, TOKEN), entry(true, 170_000_000n));
    const excluded = planCross(b, ODD, 200, true, ODD);
    assert.ok(excluded.ok, excluded.ok ? "" : excluded.reason);
    assert.ok(!excluded.executions.some((x) => x.intentIndex === 0n));
  });

  test("a cross that breaks a rule is caught by name before it is sent", () => {
    const b = book(entry(false, TOKEN), entry(true, 170_000_000n));
    const good = planCross(b, ODD, 200, false, ODD);
    assert.ok(good.ok, good.ok ? "" : good.reason);
    const bent = good.executions.map((x) => ({...x}));
    bent[0]!.executedBuy += 1n;
    assert.match(checkCross(b, ODD, false, good.price, bent) ?? "", /^UniformPriceViolated/);
    assert.match(checkCross(b, ODD, false, good.price, [...bent].reverse()) ?? "", /^ExecutionsNotAscending/);
  });

  test("500 random books, every plan passes every check _applyCross makes", () => {
    const r = rng(20260930);
    let planned = 0;
    for (let n = 0; n < 500; n += 1) {
      const ref = r.big(50_000_000n, 900_000_000n);
      const entries: BookEntry[] = [];
      for (let k = 0; k < r.int(2, 12); k += 1) {
        const buy = r.int(0, 1) === 1;
        const amount = buy ? r.big(1_000_000n, 3_000_000_000n) : r.big(TOKEN / 100n, 20n * TOKEN);
        const kind = [KIND.MOO, KIND.LOO, KIND.ROO][r.int(0, 2)]!;
        const limit = kind === KIND.LOO ? (ref * BigInt(r.int(9_700, 10_300))) / 10_000n : 0n;
        entries.push(entry(buy, amount, {kind, limitPrice: limit, maxDevFromRefBps: r.int(0, 300), escrowed: r.int(0, 9) > 0}));
      }
      const b = book(...entries);
      const rooExcluded = r.int(0, 3) === 0;
      const plan = planCross(b, ref, 200 + 50 * r.int(0, 3), rooExcluded, ref);
      if (!plan.ok) continue;
      planned += 1;
      assert.equal(checkCross(b, ref, rooExcluded, plan.price, plan.executions), null);
      for (const x of plan.executions) {
        const c = b[Number(x.intentIndex)]!;
        assert.ok(x.executedSell <= c.sellAmount);
        assert.equal(x.executedBuy, c.buy ? tokenOf(x.executedSell, plan.price) : quoteOf(x.executedSell, plan.price));
      }
    }
    assert.ok(planned > 100, `only ${planned} of 500 books produced a cross`);
  });

  test("the auction day is the UTC calendar date of the cross", () => {
    // 20726 days after the epoch is 30 September 2026, and 23:59 UTC is still that day.
    assert.equal(ymdOf(20_726n * 86_400n), 20260930);
    assert.equal(ymdOf(20_727n * 86_400n - 1n), 20260930);
  });
});
