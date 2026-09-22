import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {
  WAD,
  capScale,
  claimedSavings,
  conservation,
  exposureNotional,
  exposureViolations,
  feeCap,
  feeWithinBand,
  limitRespected,
  venueDeltas,
  withinBand,
} from "../../src/math.ts";
import {NVDA, QUOTE, solution} from "./fixtures.ts";

describe("savings", () => {
  // Kept so nobody "simplifies" the sum later. Two terms of 0.6 dollars each
  // floor to zero one by one, and to one dollar taken together. The contract
  // floors inside its loop, so zero is the only answer it accepts.
  test("is floored per term, never once over the total", () => {
    const s = solution({
      prices: [WAD, (6n * WAD) / 10n],
      executions: [
        {intentIndex: 0n, executedSell: 1n, executedBuy: 11n},
        {intentIndex: 0n, executedSell: 1n, executedBuy: 21n},
      ],
      baselineQuotes: [10n, 20n],
    });
    const perTerm = claimedSavings(s.executions, s.baselineQuotes, s.prices, s.intents, s.tokens);
    const onceAtEnd = ((1n + 1n) * s.prices[1]!) / WAD;
    assert.equal(perTerm, 0n);
    assert.equal(onceAtEnd, 1n);
  });

  test("prices each term at the buy token's price", () => {
    const s = solution();
    const expected = ((s.executions[0]!.executedBuy - s.baselineQuotes[0]!) * s.prices[1]!) / WAD + ((s.executions[1]!.executedBuy - s.baselineQuotes[1]!) * s.prices[0]!) / WAD;
    assert.equal(claimedSavings(s.executions, s.baselineQuotes, s.prices, s.intents, s.tokens), expected);
  });

  test("refuses an execution below its baseline, as verify reverts WorseThanBaseline", () => {
    const s = solution({baselineQuotes: [10n ** 30n, 0n]});
    assert.throws(() => claimedSavings(s.executions, s.baselineQuotes, s.prices, s.intents, s.tokens), /WorseThanBaseline/);
  });
});

describe("limitRespected, b*S >= B*s", () => {
  // S = 1000, B = 300, s = 10, so the threshold is b = 3.
  test("at the threshold", () => assert.equal(limitRespected(3n, 1000n, 300n, 10n), true));
  test("one wei under", () => assert.equal(limitRespected(2n, 1000n, 300n, 10n), false));
  test("one wei over", () => assert.equal(limitRespected(4n, 1000n, 300n, 10n), true));
});

describe("feeWithinBand", () => {
  // 3 bps of 10000 is exactly 3.
  test("at the ceiling", () => assert.equal(feeWithinBand(10_000n, 9_997n, 3n), true));
  test("one wei past the ceiling", () => assert.equal(feeWithinBand(10_000n, 9_996n, 3n), false));
  test("one wei inside the ceiling", () => assert.equal(feeWithinBand(10_000n, 9_998n, 3n), true));
  test("out above in is refused", () => assert.equal(feeWithinBand(10_000n, 10_001n, 3n), false));
});

describe("withinBand", () => {
  // 150 bps of 10000 is 150 either side.
  test("at the upper edge", () => assert.equal(withinBand(10_150n, 10_000n, 150n), true));
  test("one wei past the upper edge", () => assert.equal(withinBand(10_151n, 10_000n, 150n), false));
  test("one wei inside the upper edge", () => assert.equal(withinBand(10_149n, 10_000n, 150n), true));
  test("at the lower edge", () => assert.equal(withinBand(9_850n, 10_000n, 150n), true));
  test("one wei past the lower edge", () => assert.equal(withinBand(9_849n, 10_000n, 150n), false));
});

describe("feeCap", () => {
  // 20 percent of 150 is 30, 3 bps of 100000 is 30.
  test("both bounds equal", () => assert.equal(feeCap(150n, 100_000n), 30n));
  test("the share binds", () => assert.equal(feeCap(149n, 100_000n), 29n));
  test("the notional binds", () => assert.equal(feeCap(151n, 99_999n), 29n));
});

describe("conservation and venue deltas", () => {
  test("a venue call is debited amountIn and credited minOut", () => {
    const deltas = venueDeltas([{adapter: QUOTE, tokenIn: QUOTE, tokenOut: NVDA, amountIn: 100n, minOut: 7n}], [QUOTE, NVDA]);
    assert.deepEqual(deltas, [-100n, 7n]);
  });

  test("the netted fixture keeps both tokens non negative only with enough quote", () => {
    const ok = solution();
    ok.executions[0]!.executedBuy = 5_000_000_000_000_000_000n;
    assert.deepEqual(conservation(ok), [50_000_000n, 0n]);
    const short = solution();
    short.executions[1]!.executedBuy = 1_000_000_001n;
    assert.equal(conservation(short)[0]! < 0n, true);
  });
});

describe("exposure", () => {
  test("notional sums each sell side, floored per execution", () => {
    const s = solution();
    const e = exposureNotional(s);
    const quoteLeg = (s.executions[0]!.executedSell * s.prices[0]!) / WAD;
    const baseLeg = (s.executions[1]!.executedSell * s.prices[1]!) / WAD;
    assert.equal(e.notionalUsd, quoteLeg + baseLeg);
    assert.deepEqual(e.perToken, [quoteLeg, baseLeg]);
  });

  test("weekend, holiday and PROTECTIVE halve every cap", () => {
    assert.deepEqual([0, 3, 5, 6, 7, 8].map(capScale), [2n, 2n, 2n, 1n, 1n, 1n]);
  });

  test("the batch cap is halved on a weekend and checked at the edge", () => {
    const state = {capPerBatchUsd: 5000n * WAD, capPerTokenDailyUsd: 10n ** 30n, capGlobalDailyUsd: 10n ** 30n, globalToday: 0n, perTokenToday: [0n, 0n]};
    const at = {notionalUsd: 2500n * WAD, perToken: [0n, 0n]};
    assert.deepEqual(exposureViolations(at, 6, state), []);
    assert.equal(exposureViolations({...at, notionalUsd: at.notionalUsd + 1n}, 6, state).length, 1);
    assert.deepEqual(exposureViolations({...at, notionalUsd: 5000n * WAD}, 3, state), []);
  });

  test("the daily totals include what the day already spent", () => {
    const state = {capPerBatchUsd: 10n ** 30n, capPerTokenDailyUsd: 100n, capGlobalDailyUsd: 1000n, globalToday: 990n, perTokenToday: [0n, 95n]};
    const v = exposureViolations({notionalUsd: 11n, perToken: [0n, 6n]}, 3, state);
    assert.deepEqual(v.map((x) => x.split(" ")[0]), ["global", "token"]);
  });
});
