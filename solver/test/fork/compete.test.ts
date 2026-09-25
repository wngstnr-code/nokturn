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

async function inSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  const id = (await rpc("evm_snapshot")) as Hex;
  try {
    return await fn();
  } finally {
    await rpc("evm_revert", [id]);
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
