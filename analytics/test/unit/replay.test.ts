import assert from "node:assert/strict";
import {describe, test} from "node:test";
import type {BatchReceipt} from "../../../packages/shared/api-types.ts";
import type {FixtureTrade} from "../../src/extract.ts";
import {due, HARNESS_FAULTS, nettingOf, windowMismatch} from "../../src/replay.ts";

const trade = (at: number): FixtureTrade => ({at, window: 0, sym: "NVDA", side: "buy", usdMicro: "1", usdMicroOriginal: "1", trader: 0, txHash: "0x", logIndex: 0});
const receipt = (netted: string, routed: string) => ({totals: {nettedVolumeUsd: netted, routedVolumeUsd: routed}}) as BatchReceipt;

describe("replay", () => {
  test("a chain batch must cover exactly one fixture window", () => {
    assert.equal(windowMismatch(60, 60, 1), null);
    assert.equal(windowMismatch(60, 10, 6), null);
    assert.match(windowMismatch(60, 60, 12)!, /covers 720s of fixture/);
    assert.match(windowMismatch(45, 60, 1)!, /extract again/);
  });

  test("a trade is played once its offset is reached, in order, and only once", () => {
    const q = [trade(0), trade(5), trade(5), trade(9)];
    assert.deepEqual(due(q, 4).map((t) => t.at), [0]);
    assert.deepEqual(due(q, 5).map((t) => t.at), [5, 5]);
    assert.deepEqual(due(q, 5), []);
    assert.equal(q.length, 1);
  });

  test("netting comes from the receipts, and a batch counts as netted only when it netted", () => {
    const n = nettingOf([receipt("300", "100"), receipt("0", "50"), receipt("50", "0")]);
    assert.equal(n.netted, 350n);
    assert.equal(n.routed, 150n);
    assert.equal(n.ratioBps, 7_000n);
    assert.equal(n.netting, 2);
    assert.equal(nettingOf([]).ratioBps, 0n);
  });

  test("a cap saying no is not a harness fault, a stale nonce is", () => {
    assert.ok(HARNESS_FAULTS.has("NonceAlreadyUsed"));
    assert.ok(HARNESS_FAULTS.has("IntentExpired"));
    assert.ok(!HARNESS_FAULTS.has("ExposureCapExceeded"));
  });
});
