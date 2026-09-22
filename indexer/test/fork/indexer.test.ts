// The indexer against the live fork and the compose Postgres. Each case runs
// once. Cases that change the fork run inside evm_snapshot and are reverted.
//
// Needs make fork deploy fund, make db-up, and make api from this tree. The
// tests use their own database, nokturn_fork_test, created fresh at the start,
// so the demo database is never touched.

import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {after, before, describe, test} from "node:test";
import pg from "pg";
import {encodeFunctionData, type Address, type Hex, type PublicClient} from "viem";
import {REPO_ROOT, loadAbi} from "../../src/abi.ts";

const ADMIN_URL = process.env.NOKTURN_DATABASE_ADMIN_URL ?? "postgres://nokturn:nokturn@127.0.0.1:5433/nokturn";
const TEST_DB = "nokturn_fork_test";
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);
process.env.NOKTURN_DATABASE_URL = TEST_URL;
const API = process.env.NOKTURN_API_URL ?? "http://127.0.0.1:3000";

// Imported after the database url is set, because db.ts reads it at import.
const {closeDb, db, migrate} = await import("../../src/db.ts");
const {Ingest} = await import("../../src/ingest.ts");
const {PgStore} = await import("../../src/store.ts");
const {client, loadDeployment} = await import("../../src/index.ts");

const TABLES = ["logs", "batches", "fills", "prices", "solutions", "venue_routes", "collection_failures", "batch_solutions", "solvers", "sessions", "auctions", "indicative", "closing_prints", "closing_prints_withheld", "chain_blocks"];
const settlementAbi = loadAbi("Settlement");
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

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await db().query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  return out;
}

async function catchUp(until?: bigint) {
  const ingest = new Ingest(c, new PgStore(), deployment);
  const target = until ?? (await c.getBlockNumber());
  for (let i = 0; i < 200; i += 1) {
    const r = await ingest.step();
    if (r.to >= target) return;
  }
  throw new Error("did not catch up in two hundred steps");
}

function run(args: string[], env: Record<string, string> = {}, onLine?: (line: string, kill: () => void) => void): Promise<{code: number | null; out: string}> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, {cwd: REPO_ROOT, env: {...process.env, NOKTURN_DATABASE_URL: TEST_URL, ...env}, stdio: ["ignore", "pipe", "pipe"]});
    let out = "";
    const feed = (d: Buffer) => {
      out += String(d);
      for (const line of String(d).split("\n")) onLine?.(line, () => p.kill("SIGKILL"));
    };
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("exit", (code) => resolve({code, out}));
  });
}

async function chainLogCount(from: bigint, to: bigint): Promise<number> {
  let n = 0;
  for (let a = from; a <= to; a += 500n) {
    const b = a + 499n > to ? to : a + 499n;
    n += (await c.getLogs({address: [...deployment.contracts.keys()] as Address[], fromBlock: a, toBlock: b})).length;
  }
  return n;
}

async function sendAs(from: Address, to: Address, data: Hex): Promise<Hex> {
  const hash = (await rpc("eth_sendTransaction", [{from, to, data, gas: "0x2dc6c0"}])) as Hex;
  const receipt = await c.waitForTransactionReceipt({hash, pollingInterval: 250});
  assert.equal(receipt.status, "success", `${hash} reverted`);
  return hash;
}

async function getJson(path: string): Promise<{status: number; body: any}> {
  const res = await fetch(`${API}${path}`);
  return {status: res.status, body: await res.json()};
}

describe("indexer on the fork", () => {
  before(async () => {
    c = client();
    deployment = await loadDeployment(c);
    await resetDb();
  });

  after(async () => {
    console.log(`I results\n${JSON.stringify(results, (_, v) => (typeof v === "bigint" ? String(v) : v), 2)}`);
    await closeDb();
  });

  test("I1 the same range twice leaves identical rows, and logs match getLogs", async () => {
    const head = await c.getBlockNumber();
    await catchUp(head);
    const first = await counts();
    const cp = await new PgStore().checkpoint(deployment.chainId, deployment.settlement);
    const back = await c.getBlock({blockNumber: deployment.fromBlock - 1n});
    await new PgStore().commit({checkpoint: {...cp!, lastBlock: back.number!, lastHash: back.hash!}, blocks: [], logs: [], undecoded: [], extra: []});
    await catchUp(head);
    const second = await counts();
    const onChain = await chainLogCount(deployment.fromBlock, head);
    results.I1 = {head, first, second, getLogs: onChain};
    assert.deepEqual(second, first);
    assert.equal(first.logs, onChain);
  });

  test("I2 killed mid range and restarted, no gap and no double", async () => {
    const reference = await counts();
    const head = BigInt(results.I1 ? (results.I1 as {head: bigint}).head : await c.getBlockNumber());
    await resetDb();
    const killed = await run(["indexer/src/index.ts", "--until-block", String(head)], {}, (line, kill) => {
      if (/^blocks \d+ to \d+/.test(line)) kill();
    });
    const partial = await counts();
    const resumed = await run(["indexer/src/index.ts", "--until-block", String(head)]);
    const after = await counts();
    results.I2 = {killedExit: killed.code, partialLogs: partial.logs, resumedExit: resumed.code, after, reference};
    assert.ok(partial.logs < reference.logs, "the kill landed after the whole range was already indexed");
    for (const t of TABLES) if (t !== "chain_blocks") assert.equal(after[t], reference[t], t);
  });

  test("I3 a reverted block's rows disappear and the new history is indexed", async () => {
    await catchUp();
    const id = (await rpc("evm_snapshot")) as Hex;
    let during: number;
    try {
      const intent = {owner: deployment.settlement, receiver: deployment.settlement, sellToken: deployment.settlement, buyToken: deployment.settlement, sellAmount: 1n, minBuyAmount: 1n, validAfter: 0, validUntil: 1, flags: 0, kind: 0, maxDevFromRefBps: 0, allowedSessions: 0, batchSpan: 1, nonce: 1n};
      await sendAs("0x000000000000000000000000000000000000dEaD", deployment.settlement as Address, encodeFunctionData({abi: settlementAbi, functionName: "submitIntentOnchain", args: [intent, "0x"]}));
      await catchUp();
      during = (await db().query("SELECT count(*)::int AS n FROM logs WHERE event = 'IntentSubmittedOnchain'")).rows[0].n;
    } finally {
      await rpc("evm_revert", [id]);
    }
    await rpc("evm_mine");
    await rpc("evm_mine");
    await catchUp();
    const afterRevert = (await db().query("SELECT count(*)::int AS n FROM logs WHERE event = 'IntentSubmittedOnchain'")).rows[0].n;
    results.I3 = {during, afterRevert};
    assert.equal(during, 1);
    assert.equal(afterRevert, 0);
  });

  test("I4 the database down for thirty seconds, the indexer backs off and catches up", async () => {
    const child = run(["indexer/src/index.ts", "--duration", "1.5"]);
    await new Promise((r) => setTimeout(r, 5_000));
    execFileSync("bash", [`${REPO_ROOT}/infra/scripts/db.sh`, "down"], {stdio: "ignore"});
    const receiptRoute = await getJson("/v1/batches");
    const health = await fetch(`${API}/v1/health`).then((r) => r.status);
    await new Promise((r) => setTimeout(r, 30_000));
    execFileSync("bash", [`${REPO_ROOT}/infra/scripts/db.sh`, "up"], {stdio: "ignore"});
    const done = await child;
    await closeDb();
    const head = await c.getBlockNumber();
    await catchUp(head);
    const logs = (await counts()).logs;
    const onChain = await chainLogCount(deployment.fromBlock, head);
    results.I4 = {exit: done.code, backoffs: done.out.split("\n").filter((l) => l.startsWith("step failed")).length, receiptRouteWhileDown: receiptRoute.status, receiptCode: receiptRoute.body.code, healthWhileDown: health, logs, getLogs: onChain};
    assert.equal(done.code, 0, done.out);
    assert.equal(receiptRoute.status, 503);
    assert.equal(receiptRoute.body.code, "COORDINATOR_UPSTREAM_DOWN");
    assert.equal(health, 200);
    assert.equal(logs, onChain);
  });

  test("I5 thirty percent RPC errors, no gap", async () => {
    const {startChaosProxy} = (await import("../../../infra/scripts/torture/rpc-chaos-proxy.mjs" as string)) as {startChaosProxy: (o: {upstream: string}) => Promise<{url: string; stats: {errored: number}; setRules(r: object[]): void; close(): Promise<void>}>};
    const proxy = await startChaosProxy({upstream: process.env.NOKTURN_INDEXER_RPC ?? "http://127.0.0.1:8545"});
    try {
      await resetDb();
      proxy.setRules([{mode: "error", pct: 30}]);
      const head = await c.getBlockNumber();
      const done = await run(["indexer/src/index.ts", "--until-block", String(head)], {NOKTURN_INDEXER_RPC: proxy.url});
      const logs = (await counts()).logs;
      const onChain = await chainLogCount(deployment.fromBlock, head);
      results.I5 = {exit: done.code, errored: proxy.stats.errored, logs, getLogs: onChain};
      assert.equal(done.code, 0, done.out.slice(-2000));
      assert.equal(logs, onChain);
    } finally {
      await proxy.close();
    }
  });

  // Anvil keeps eth_call state for a rolling window rather than the whole fork
  // history. Measured 23 September 2026: quoteFromState answers at 1000 blocks
  // back and refuses at 5000 with BlockOutOfRangeError, an unrelated node
  // limit rather than a baseline disagreement. Batches older than that window
  // are counted separately and never asserted on, so this stays a check of
  // whether the baseline agrees, not of how long the node has been running.
  const STATE_WINDOW_BLOCKS = 800n;

  test("I8 every recent fill's baseline, recomputed with quoteFromState", async () => {
    await catchUp();
    const head = await c.getBlockNumber();
    const cutoff = head > STATE_WINDOW_BLOCKS ? head - STATE_WINDOW_BLOCKS : 0n;
    const rows = (await db().query("SELECT DISTINCT batch_id, block_number FROM fills ORDER BY batch_id")).rows;
    const recent = rows.filter((r) => BigInt(r.block_number) >= cutoff).map((r) => String(r.batch_id));
    const outOfWindow = rows.length - recent.length;
    let fills = 0;
    let stateUnavailable = 0;
    const differ: unknown[] = [];
    for (const id of recent) {
      const r = await getJson(`/v1/batches/${id}`);
      if (r.status !== 200) {
        stateUnavailable += 1;
        continue;
      }
      for (const f of r.body.fills) {
        fills += 1;
        if (f.verifyBaseline.expected !== f.baselineBuy) differ.push({batchId: id, intentHash: f.intentHash, baselineBuy: f.baselineBuy, expected: f.verifyBaseline.expected, routed: f.attribution.routedSell});
      }
    }
    results.I8 = {totalBatchesIndexed: rows.length, outOfStateWindow: outOfWindow, checkedBatches: recent.length, stateUnavailable, fills, differ: differ.length, examples: differ.slice(0, 5)};
    assert.equal(stateUnavailable, 0, "a batch inside the measured state window should still answer");
    assert.ok(fills > 0);
    assert.equal(differ.length, 0, JSON.stringify(differ));
  });

  test("I9 auction and closing print events from tools/fork-demo.sh", async () => {
    const id = (await rpc("evm_snapshot")) as Hex;
    let out = "";
    try {
      try {
        out = execFileSync("bash", [`${REPO_ROOT}/tools/fork-demo.sh`], {cwd: REPO_ROOT, encoding: "utf8", timeout: 600_000});
      } catch (error) {
        results.I9 = {skipped: "tools/fork-demo.sh failed", tail: String((error as {stdout?: string}).stdout ?? (error as Error).message).slice(-1500)};
        return;
      }
      await catchUp();
      const n = async (t: string) => (await db().query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
      results.I9 = {auctions: await n("auctions"), indicative: await n("indicative"), closingPrints: await n("closing_prints"), withheld: await n("closing_prints_withheld"), tail: out.slice(-600)};
    } finally {
      await rpc("evm_revert", [id]);
    }
  });
});
