// F28 on the fork. Reconciliation against direct contract reads, and the
// confirmation depth. Each case runs once.
//
// Needs make fork deploy fund, make db-up, and at least one settled batch on
// the fork, which infra/scripts/m2.mjs leaves behind. Uses its own database,
// nokturn_reconcile_test, so neither the demo database nor the indexer suite's
// is touched.

import assert from "node:assert/strict";
import {after, before, describe, test} from "node:test";
import pg from "pg";
import {encodeFunctionData, type Address, type Hex, type PublicClient} from "viem";
import {loadAbi} from "../../src/abi.ts";

const ADMIN_URL = process.env.NOKTURN_DATABASE_ADMIN_URL ?? "postgres://nokturn:nokturn@127.0.0.1:5433/nokturn";
const TEST_DB = "nokturn_reconcile_test";
process.env.NOKTURN_DATABASE_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);

const {closeDb, db, migrate} = await import("../../src/db.ts");
const {Ingest} = await import("../../src/ingest.ts");
const {PgStore} = await import("../../src/store.ts");
const {client, loadDeployment, reconcileCommand} = await import("../../src/index.ts");
const {reconcile, viemReader} = await import("../../src/reconcile.ts");

const results: Record<string, unknown> = {};
let c: PublicClient;
let deployment: Awaited<ReturnType<typeof loadDeployment>>;
const rpc = (method: string, params: unknown[] = []) => c.request({method: method as never, params: params as never});

async function resetDb() {
  const admin = new pg.Client({connectionString: ADMIN_URL});
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  await closeDb();
  await migrate();
}

async function catchUp(ingest = new Ingest(c, new PgStore(), deployment)) {
  const target = await ingest.safeHead();
  for (let i = 0; i < 200; i += 1) {
    const r = await ingest.step();
    if (r.to >= target) return;
  }
  throw new Error("did not catch up in two hundred steps");
}

describe("reconciliation on the fork", () => {
  before(async () => {
    c = client();
    deployment = await loadDeployment(c);
    await resetDb();
  });

  after(async () => {
    console.log(`reconcile results\n${JSON.stringify(results, (_, v) => (typeof v === "bigint" ? String(v) : v), 2)}`);
    await closeDb();
  });

  test("I10 every row matches the chain after the M2 batch is indexed", async () => {
    await catchUp();
    const settled = (await db().query("SELECT count(*)::int AS n FROM batches WHERE outcome = 'settled'")).rows[0].n;
    assert.ok(settled > 0, "no settled batch on this fork. run infra/scripts/m2.mjs first");
    const lines: string[] = [];
    const code = await reconcileCommand(undefined, (l) => lines.push(l));
    const summary = lines.at(-1)!.split("\n").at(-1)!;
    results.I10 = {settledBatches: settled, exit: code, summary};
    assert.equal(code, 0, lines.join("\n"));
  });

  // The edit happens inside a transaction that is rolled back, so the table
  // holds the indexed value again the moment the check is done.
  test("I11 a fill changed on purpose is found, by column, and exits non zero", async () => {
    const cp = await new PgStore().checkpoint(deployment.chainId, deployment.settlement);
    const adapter = (await c.readContract({address: deployment.settlement as Address, abi: loadAbi("Settlement"), functionName: "baselineAdapter"})) as Address;
    const conn = await db().connect();
    try {
      await conn.query("BEGIN");
      const target = (await conn.query("SELECT tx_hash, log_index, batch_id, savings_usd FROM fills ORDER BY block_number DESC, log_index LIMIT 1")).rows[0];
      assert.ok(target, "no fill to change");
      await conn.query("UPDATE fills SET savings_usd = savings_usd + 1 WHERE tx_hash = $1 AND log_index = $2", [target.tx_hash, target.log_index]);
      const checks = await reconcile(conn, viemReader(c, deployment, cp!.lastBlock, adapter), deployment.settlement, cp!.lastBlock);
      const differ = checks.filter((ch) => ch.status === "differ");
      results.I11 = {changed: {batchId: target.batch_id, from: target.savings_usd}, differ};
      assert.equal(differ.length, 1, JSON.stringify(differ));
      assert.equal(differ[0]!.check, "sum(fills.savings_usd)");
      assert.equal(differ[0]!.subject, `batch ${target.batch_id}`);
    } finally {
      await conn.query("ROLLBACK");
      conn.release();
    }
  });

  // The fork mines on a one second interval, so interval mining is frozen for
  // the case and every block is mined by hand. Restored in finally.
  test("I12 with two confirmations an event waits two more blocks", async () => {
    const ingest = new Ingest(c, new PgStore(), deployment, () => {}, 2n);
    const id = (await rpc("evm_snapshot")) as Hex;
    await rpc("evm_setIntervalMining", [0]);
    try {
      await catchUp(ingest);
      const intent = {owner: deployment.settlement, receiver: deployment.settlement, sellToken: deployment.settlement, buyToken: deployment.settlement, sellAmount: 1n, minBuyAmount: 1n, validAfter: 0, validUntil: 1, flags: 0, kind: 0, maxDevFromRefBps: 0, allowedSessions: 0, batchSpan: 1, nonce: 12n};
      await rpc("eth_sendTransaction", [{from: "0x000000000000000000000000000000000000dEaD", to: deployment.settlement, data: encodeFunctionData({abi: loadAbi("Settlement"), functionName: "submitIntentOnchain", args: [intent, "0x"]}), gas: "0x2dc6c0"}]);
      await rpc("evm_mine");
      const held = async () => (await db().query("SELECT count(*)::int AS n FROM logs WHERE event = 'IntentSubmittedOnchain' AND args->'intent'->>'nonce' = '12'")).rows[0].n as number;
      const seen: number[] = [];
      await ingest.step();
      seen.push(await held());
      await rpc("evm_mine");
      await ingest.step();
      seen.push(await held());
      await rpc("evm_mine");
      await ingest.step();
      seen.push(await held());
      results.I12 = {afterEventBlock: seen[0], afterOneMore: seen[1], afterTwoMore: seen[2]};
      assert.deepEqual(seen, [0, 0, 1]);
    } finally {
      await rpc("evm_revert", [id]);
      await rpc("evm_setIntervalMining", [1]);
    }
  });
});
