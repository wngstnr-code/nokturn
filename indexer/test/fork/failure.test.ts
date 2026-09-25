// The three failure receipts, through the same function make demo-fail runs, so
// what is tested is the command the demo uses. Each case runs once, inside
// evm_snapshot, because expired slashes solverA's bond and would otherwise
// shrink it on every run.
//
// Needs make fork deploy fund, make db-up and make api, and no make solver.

import assert from "node:assert/strict";
import {after, before, describe, test} from "node:test";
import type {Hex, PublicClient} from "viem";

const {client} = await import("../../src/index.ts");
const {demoFail} = (await import("../../../infra/scripts/demo-fail.mjs" as string)) as {
  demoFail: (name: string, log?: (line: string) => void) => Promise<{ok: boolean; batchId?: string; attempts: number; tried: unknown[]; checks: {label: string; ok: boolean; detail: unknown}[]}>;
};

const results: Record<string, unknown> = {};
let c: PublicClient;
const rpc = (method: string, params: unknown[] = []) => c.request({method: method as never, params: params as never});

async function inSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  const id = (await rpc("evm_snapshot")) as Hex;
  try {
    return await fn();
  } finally {
    await rpc("evm_revert", [id]);
  }
}

describe("failure receipts on the fork", () => {
  before(() => {
    c = client();
  });

  after(() => {
    console.log(`failure results\n${JSON.stringify(results, null, 2)}`);
  });

  for (const name of ["passthrough", "expired", "unwound"]) {
    test(`make demo-fail CASE=${name}`, async () => {
      const r = await inSnapshot(() => demoFail(name, () => {}));
      results[name] = {batchId: r.batchId, attempts: r.attempts, tried: r.tried, failed: r.checks.filter((x) => !x.ok)};
      assert.ok(r.checks.length > 0, `no batch reached the case in ${r.attempts} attempts: ${JSON.stringify(r.tried)}`);
      for (const x of r.checks) assert.ok(x.ok, `${x.label}: ${JSON.stringify(x.detail)}`);
    });
  }
});
