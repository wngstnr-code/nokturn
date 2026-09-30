// F23 on the fork, through the same function make demo-compete runs. Each case
// runs once, inside evm_snapshot, so the two solvers' scores go back to where
// they were.
//
// Needs make fork deploy fund, make db-up and make api, and no make solver.

import assert from "node:assert/strict";
import {after, describe, test} from "node:test";
import {createPublicClient, http, type Hex} from "viem";

type Result = {ok: boolean; batches: {batchId: string; order: string[]; loserCameSecond: boolean; checks: {label: string; ok: boolean; detail: unknown}[]}[]};
const {compete} = (await import("../../../infra/scripts/demo-compete.mjs" as string)) as {compete: (o: {batches?: number; sameSide?: boolean; log?: (l: string) => void}) => Promise<Result>};

const c = createPublicClient({transport: http(process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545")});
const rpc = (method: string, params: unknown[] = []) => c.request({method: method as never, params: params as never});
const results: Record<string, unknown> = {};

/**
 * Reverted so the solvers' scores go back, then moved past where the case
 * ended. The API's mempool does not rewind, so the case's intents would
 * otherwise sit pending in batches the chain has not reached yet, and D4 would
 * count them against the same owners in the next case. 310 is the solution
 * window plus the finalize deadline, after which the mempool sweeps a batch.
 */
async function inSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  const id = (await rpc("evm_snapshot")) as Hex;
  try {
    return await fn();
  } finally {
    const ended = (await c.getBlock()).timestamp;
    await rpc("evm_revert", [id]);
    await rpc("evm_setNextBlockTimestamp", [Number(ended + 310n + 60n)]);
    await rpc("evm_mine");
  }
}

function assertAll(r: Result) {
  for (const b of r.batches) for (const x of b.checks) assert.ok(x.ok, `batch ${b.batchId}, ${x.label}: ${JSON.stringify(x.detail)}`);
}

describe("two solvers on the fork", () => {
  after(() => console.log(`compete results\n${JSON.stringify(results, null, 2)}`));

  test("profile a beats profile b on three batches running", async () => {
    const r = await inSnapshot(() => compete({batches: 3, log: () => {}}));
    results.threeBatches = r.batches.map((b) => ({batchId: b.batchId, order: b.order, loserCameSecond: b.loserCameSecond}));
    assert.equal(r.batches.length, 3);
    assertAll(r);
  });

  test("two intents on one side save nothing either way, and the first to arrive wins", async () => {
    const r = await inSnapshot(() => compete({batches: 1, sameSide: true, log: () => {}}));
    results.sameSide = r.batches.map((b) => ({batchId: b.batchId, order: b.order}));
    assertAll(r);
  });
});
