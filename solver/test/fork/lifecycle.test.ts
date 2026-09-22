// F21 under failure, against the coordinator on :3000 and the fork under it.
// Each case runs once. E5 and E6 change state a third party owns, a pool and a
// user's balance, so they run inside evm_snapshot and are reverted. E1 to E4
// settle ordinary batches the way the service would and leave them.
//
// A batch is never reused across cases. A revert rewinds chain time, and the
// coordinator still holds the intents it accepted for the batches it saw.

import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, describe, test} from "node:test";
import {decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256, type Address, type Hex, type PublicClient} from "viem";
import type {HDAccount} from "viem/accounts";
import type {CurrentBatchResponse, NonceResponse} from "../../../packages/shared/api-types.ts";
import {STOCK_TOKENS, USDG} from "../../../packages/shared/addresses.ts";
import {REPO_ROOT, adapterAbi, settlementAbi} from "../../src/abi.ts";
import {solverAccount} from "../../src/account.ts";
import {quote} from "../../src/baseline.ts";
import {API, RPC, client, contracts, settlementAddress, type Contracts} from "../../src/chain.ts";
import {feed, solveAt} from "../../src/feed.ts";
import {finalizeWon, untilBlock} from "../../src/finalize.ts";
import {submit} from "../../src/send.ts";
import {PARTIAL_FILL, type Intent, type Solution} from "../../src/solution.ts";
import {Store} from "../../src/store.ts";
import {intentFor, sign, users} from "./lib.ts";

const QUOTE = USDG as Address;
const NVDA = STOCK_TOKENS.NVDA as Address;
const SOLVER_B = "0xA153D1d2912c3db3e749CCBDef0C165Dd7b728BE" as Address;

let c: PublicClient;
let k: Contracts;
let who: HDAccount[];
let lastBatch = 0n;
const results: Record<string, unknown> = {};

interface ChaosProxy {
  url: string;
  stats: {requests: number; errored: number};
  setRules(rules: object[]): void;
  pass(): void;
  close(): Promise<void>;
}
// The torture suite's proxy is untyped JavaScript, so it is loaded by path.
const CHAOS_PROXY = "../../../infra/scripts/torture/rpc-chaos-proxy.mjs";
const startChaosProxy = async (opts: {upstream: string}) =>
  ((await import(CHAOS_PROXY)) as {startChaosProxy: (o: {upstream: string}) => Promise<ChaosProxy>}).startChaosProxy(opts);

const rpc = (method: string, params: unknown[] = []) => c.request({method: method as never, params: params as never});
const freshStore = () => new Store(mkdtempSync(join(tmpdir(), "nokturn-e-")));

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** The first batch after every batch an earlier case used, with 25 seconds of collection left. */
function freshBatch(): Promise<CurrentBatchResponse> {
  return new Promise((resolve, reject) => {
    const unwatch = c.watchBlocks({
      emitOnBegin: true,
      pollingInterval: 500,
      onBlock: async () => {
        try {
          const b = await get<CurrentBatchResponse>("/v1/batches/current");
          if (b.batchId !== null && BigInt(b.batchId) > lastBatch && b.collectEndsAt - b.chainTime >= 25) {
            unwatch();
            lastBatch = BigInt(b.batchId);
            resolve(b);
          }
        } catch (error) {
          unwatch();
          reject(error);
        }
      },
    });
  });
}

async function venue(tokenIn: Address, tokenOut: Address, amount: bigint): Promise<bigint> {
  const q = await quote(c, k.baselineAdapter, tokenIn, tokenOut, amount, await c.getBlockNumber());
  if (!q.ok) throw new Error(q.error);
  return q.out;
}

async function post(account: HDAccount, batch: CurrentBatchResponse, fields: Pick<Intent, "sellToken" | "buyToken" | "sellAmount" | "minBuyAmount" | "flags">): Promise<void> {
  const nonce = BigInt((await get<NonceResponse>(`/v1/nonces/${account.address}`)).next);
  const intent = intentFor(account.address, {...fields, validAfter: batch.chainTime - 60, validUntil: batch.collectEndsAt + 3600, allowedSessions: 1 << batch.session, nonce});
  const signature = await sign(c, k.settlement, account, intent);
  const payload = Object.fromEntries(Object.entries(intent).map(([key, v]) => [key, typeof v === "bigint" ? String(v) : v]));
  const res = await fetch(`${API}/v1/intents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({intent: payload, signature})});
  const body = (await res.json()) as {batchId?: string; code?: string; message?: string};
  if (!res.ok) throw new Error(`POST /v1/intents answered ${res.status} ${body.code}: ${body.message}`);
  assert.equal(body.batchId, batch.batchId, "a boundary fell between the submissions");
}

async function placeNetted(): Promise<bigint> {
  const batch = await freshBatch();
  const sell = 200n * 10n ** 6n;
  const askOut = await venue(QUOTE, NVDA, sell);
  const bidOut = await venue(NVDA, QUOTE, askOut);
  const buyNvda = (askOut * 2n * sell) / (sell + bidOut);
  await post(who[0]!, batch, {sellToken: QUOTE, buyToken: NVDA, sellAmount: sell, minBuyAmount: buyNvda, flags: PARTIAL_FILL});
  await post(who[1]!, batch, {sellToken: NVDA, buyToken: QUOTE, sellAmount: buyNvda, minBuyAmount: (await venue(NVDA, QUOTE, buyNvda)) + 1n, flags: PARTIAL_FILL});
  return BigInt(batch.batchId!);
}

async function placeRouted(): Promise<bigint> {
  const batch = await freshBatch();
  for (const [account, sell] of [[who[0]!, 60n * 10n ** 6n], [who[1]!, 90n * 10n ** 6n]] as const) {
    await post(account, batch, {sellToken: QUOTE, buyToken: NVDA, sellAmount: sell, minBuyAmount: ((await venue(QUOTE, NVDA, sell)) * 99n) / 100n, flags: 0});
  }
  return BigInt(batch.batchId!);
}

/** Waits for collection to close and solves the batch the way the service does. */
async function solveClosed(batchId: bigint): Promise<Solution> {
  await untilBlock(c, (ts) => ts > batchId, batchId + 10n);
  const {signed} = await feed(batchId);
  const {plan} = await solveAt(c, k, batchId, signed, solverAccount().address, await c.getBlockNumber());
  assert.ok(plan.solution.executions.length > 0, `batch ${batchId} solved to nothing: ${plan.pairs.map((p) => p.reason).join("; ")}`);
  return plan.solution;
}

async function sendAs(from: Address, to: Address, data: Hex): Promise<Hex> {
  const hash = (await rpc("eth_sendTransaction", [{from, to, data, gas: "0x2dc6c0"}])) as Hex;
  const receipt = await c.waitForTransactionReceipt({hash, pollingInterval: 250});
  assert.equal(receipt.status, "success", `${from} to ${to} reverted in ${hash}`);
  return hash;
}

async function eventsFor(batchId: bigint, fromBlock: bigint): Promise<string[]> {
  const logs = await c.getContractEvents({address: k.settlement, abi: settlementAbi(), fromBlock, toBlock: "latest"});
  return logs
    .filter((l) => (l.args as {batchId?: bigint}).batchId === batchId)
    .map((l) => (l.eventName === "BatchPassthrough" ? `BatchPassthrough(${(l.args as {reason: string}).reason})` : l.eventName!));
}

const isFinalized = (batchId: bigint) => c.readContract({address: k.settlement, abi: settlementAbi(), functionName: "finalized", args: [batchId]}) as Promise<boolean>;

function runChild(args: string[], env: Record<string, string>): Promise<{code: number | null; signal: string | null; out: string}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {cwd: REPO_ROOT, env: {...process.env, ...env}, stdio: ["ignore", "pipe", "pipe"]});
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.on("exit", (code, signal) => resolve({code, signal, out}));
  });
}

describe("F21 lifecycle under failure", () => {
  before(async () => {
    c = client();
    k = await contracts(c, settlementAddress());
    who = users();
    await get("/v1/health");
  });

  after(() => console.log(`E results\n${JSON.stringify(results, (_, v) => (typeof v === "bigint" ? String(v) : v), 2)}`));

  test("E1 killed right after the submit receipt, a restart finalizes it", async () => {
    const state = mkdtempSync(join(tmpdir(), "nokturn-e1-"));
    const from = await c.getBlockNumber();
    const batchId = await placeNetted();
    const victim = await runChild(["solver/test/fork/crash-after-submit.ts", String(batchId)], {NOKTURN_SOLVER_STATE: state});
    const crashed = new Store(state).read(batchId);
    const before = crashed.ok ? crashed.record.status : crashed.reason;
    const restart = await runChild(["solver/src/index.ts", "--run", "--duration", "1"], {NOKTURN_SOLVER_STATE: state});
    const after = new Store(state).read(batchId);
    results.E1 = {batchId, victim: {code: victim.code, signal: victim.signal, out: victim.out.trim()}, statusAtCrash: before, restart: restart.out.trim().split("\n").filter((l) => /recover|batch .* \|/.test(l)), statusAfter: after.ok ? after.record.status : after.reason, events: await eventsFor(batchId, from)};
    assert.equal(before, "best");
    assert.ok(after.ok);
    assert.equal(after.record.status, "finalized", after.record.reason ?? "");
    assert.ok((results.E1 as {events: string[]}).events.includes("BatchSettled"));
  });

  test("E2 another solver finalizes first with the calldata it read, not a failure", async () => {
    const from = await c.getBlockNumber();
    const batchId = await placeNetted();
    const s = await solveClosed(batchId);
    const store = freshStore();
    const sent = await submit(c, solverAccount(), k, s, store);
    assert.equal(sent.status, "best");
    const tx = await c.getTransaction({hash: (sent as {tx: Hex}).tx});
    const {args} = decodeFunctionData({abi: settlementAbi(), data: tx.input});
    const published = args![0] as Solution;
    await untilBlock(c, (ts) => ts > batchId + 10n, batchId + 310n);
    const byB = await sendAs(SOLVER_B, k.settlement, encodeFunctionData({abi: settlementAbi(), functionName: "finalize", args: [batchId, published]}));
    const outcome = await finalizeWon(c, solverAccount(), k, s, store);
    results.E2 = {batchId, finalizeBySolverB: byB, status: outcome.status, result: outcome.result, events: await eventsFor(batchId, from)};
    assert.equal(outcome.status, "finalized_by_other");
    assert.equal(outcome.tx, null, "solverA sent a finalize of its own");
  });

  test("E3 held past solveEnd, nothing is sent", async () => {
    const batchId = await placeNetted();
    const s = await solveClosed(batchId);
    await untilBlock(c, (ts) => ts > batchId + 10n, batchId + 310n);
    const nonceBefore = await c.getTransactionCount({address: solverAccount().address});
    const store = freshStore();
    const sent = await submit(c, solverAccount(), k, s, store);
    const nonceAfter = await c.getTransactionCount({address: solverAccount().address});
    results.E3 = {batchId, status: sent.status, reason: "reason" in sent ? sent.reason : null, solverNonce: `${nonceBefore} -> ${nonceAfter}`, stored: store.batchIds()};
    assert.equal(sent.status, "window_missed");
    assert.equal(nonceAfter, nonceBefore);
    assert.deepEqual(store.batchIds(), []);
  });

  test("E4 thirty percent of RPC answers are errors for one batch, the solver does not crash", async () => {
    const proxy = await startChaosProxy({upstream: RPC});
    const from = await c.getBlockNumber();
    try {
      const state = mkdtempSync(join(tmpdir(), "nokturn-e4-"));
      const child = runChild(["solver/src/index.ts", "--run", "--duration", "2"], {NOKTURN_SOLVER_RPC: proxy.url, NOKTURN_SOLVER_STATE: state});
      const batchId = await placeNetted();
      proxy.setRules([{mode: "error", pct: 30}]);
      await untilBlock(c, (ts) => ts > batchId + 40n, batchId + 310n);
      proxy.pass();
      const done = await child;
      const line = done.out.split("\n").find((l) => l.startsWith(`batch ${batchId} |`)) ?? null;
      results.E4 = {batchId, exit: done.code, line, errored: proxy.stats.errored, requests: proxy.stats.requests, finalizedOnChain: await isFinalized(batchId), events: await eventsFor(batchId, from), summary: done.out.split("\n").filter((l) => /^(stopping|stream closed|batches|  |sum|stream|close)/.test(l))};
      assert.equal(done.code, 0, done.out);
      assert.ok(line, "no line for the chaos batch");
    } finally {
      await proxy.close();
    }
  });

  test("E5 the pool moves between submit and finalize on a routed solution", async () => {
    const id = (await rpc("evm_snapshot")) as Hex;
    try {
      const from = await c.getBlockNumber();
      const batchId = await placeRouted();
      const s = await solveClosed(batchId);
      assert.ok(s.venueCalls.length > 0, "the solution is not routed");
      const store = freshStore();
      const sent = await submit(c, solverAccount(), k, s, store);
      assert.equal(sent.status, "best");
      const swapper = who[3]!.address;
      const size = 5n * 10n ** 6n;
      await sendAs(swapper, QUOTE, encodeFunctionData({abi: erc20Abi, functionName: "approve", args: [k.baselineAdapter, maxUint256]}));
      const swapTx = await sendAs(swapper, k.baselineAdapter, encodeFunctionData({abi: adapterAbi(), functionName: "swap", args: [QUOTE, NVDA, size, 0n]}));
      const outcome = await finalizeWon(c, solverAccount(), k, s, store);
      results.E5 = {batchId, venueCall: s.venueCalls[0], swap: {tx: swapTx, from: swapper, usdg: size}, status: outcome.status, result: outcome.result, finalizeTx: outcome.tx, finalizedOnChain: await isFinalized(batchId), events: await eventsFor(batchId, from)};
    } finally {
      await rpc("evm_revert", [id]);
    }
  });

  test("E6 an owner moves their sell balance after submit", async () => {
    const id = (await rpc("evm_snapshot")) as Hex;
    try {
      const from = await c.getBlockNumber();
      const batchId = await placeNetted();
      const s = await solveClosed(batchId);
      const store = freshStore();
      const sent = await submit(c, solverAccount(), k, s, store);
      assert.equal(sent.status, "best");
      const owner = who[1]!.address;
      const balance = (await c.readContract({address: NVDA, abi: erc20Abi, functionName: "balanceOf", args: [owner]})) as bigint;
      const moveTx = await sendAs(owner, NVDA, encodeFunctionData({abi: erc20Abi, functionName: "transfer", args: [who[2]!.address, balance]}));
      const outcome = await finalizeWon(c, solverAccount(), k, s, store);
      results.E6 = {batchId, move: {tx: moveTx, owner, nvda: balance}, status: outcome.status, result: outcome.result, finalizeTx: outcome.tx, finalizedOnChain: await isFinalized(batchId), events: await eventsFor(batchId, from)};
      assert.notEqual(outcome.status, "abandoned");
    } finally {
      await rpc("evm_revert", [id]);
    }
  });
});
