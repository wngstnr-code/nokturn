import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {directions, report, sample, type Check} from "../../src/reconcile.ts";

describe("reconcile", () => {
  test("the baseline sample is the same every run and never repeats a fill", () => {
    const rows = Array.from({length: 40}, (_, i) => i);
    const first = sample(rows, 10, 7);
    assert.deepEqual(sample(rows, 10, 7), first);
    assert.equal(new Set(first).size, 10);
    assert.notDeepEqual(sample(rows, 10, 8), first);
    assert.deepEqual(sample([1, 2], 10, 7).sort(), [1, 2]);
  });

  test("fills group by batch and direction, summed, at the block before the winning submit", () => {
    const fill = (batch: number, sell: string, buy: string, executedSell: string, baselineBuy: string) => ({batch_id: batch, sell_token: sell, buy_token: buy, executed_sell: executedSell, baseline_buy: baselineBuy, submit_block: "100", block_number: "105"});
    const out = directions([fill(1, "0xA", "0xB", "10", "20"), fill(1, "0xa", "0xb", "5", "9"), fill(1, "0xB", "0xA", "7", "3"), fill(2, "0xA", "0xB", "1", "2")]);
    assert.deepEqual(
      out.map((d) => [d.batchId, d.sellToken, d.buyToken, d.fills, d.executedSell, d.baselineBuy, d.block]),
      [
        ["1", "0xa", "0xb", 2, 15n, 29n, 99n],
        ["1", "0xb", "0xa", 1, 7n, 3n, 99n],
        ["2", "0xa", "0xb", 1, 1n, 2n, 99n],
      ],
    );
  });

  test("the report prints both numbers of a difference and counts it", () => {
    const checks: Check[] = [
      {check: "count(fills)", subject: "batch 1", db: "2", chain: "2", status: "match"},
      {check: "sum(fills.savings_usd)", subject: "batch 1", db: "14", chain: "15", status: "differ", note: "off by 1 wei, tolerance 0"},
    ];
    const text = report(checks);
    assert.match(text, /differ\s+sum\(fills\.savings_usd\)\s+batch 1\s+14\s+15/);
    assert.match(text, /2 checks, 1 match, 1 differ, 0 unreadable/);
  });
});
