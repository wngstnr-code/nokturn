import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {report, sample, type Check} from "../../src/reconcile.ts";

describe("reconcile", () => {
  test("the baseline sample is the same every run and never repeats a fill", () => {
    const rows = Array.from({length: 40}, (_, i) => i);
    const first = sample(rows, 10, 7);
    assert.deepEqual(sample(rows, 10, 7), first);
    assert.equal(new Set(first).size, 10);
    assert.notDeepEqual(sample(rows, 10, 8), first);
    assert.deepEqual(sample([1, 2], 10, 7).sort(), [1, 2]);
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
