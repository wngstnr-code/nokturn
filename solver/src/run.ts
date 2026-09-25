// The solver as a service. Every batch the stream closes is solved, submitted
// once and finalized, each as its own task with a hard deadline, so no batch can
// hold up another and no task can outlive solveEnd + FINALIZE_DEADLINE.
//
// Time comes from blocks. --duration is counted in chain seconds from the head
// at start, and the process exits on its own when it runs out.

import type {Hex, PublicClient} from "viem";
import type {HDAccount} from "viem/accounts";
import type {StreamEvent} from "../../packages/shared/api-types.ts";
import {settlementAbi} from "./abi.ts";
import {solverAccount} from "./account.ts";
import {API, client, contracts, settlementAddress, type Contracts} from "./chain.ts";
import {feed, solveAt} from "./feed.ts";
import {finalizeWon, untilBlock} from "./finalize.ts";
import {assertReady} from "./preflight.ts";
import {recover} from "./recover.ts";
import {FINALIZE_DEADLINE, SOLUTION_WINDOW, submit} from "./send.ts";
import {preflight} from "./simulate.ts";
import type {SignedIntent} from "./solve.ts";
import {Store, storeDir} from "./store.ts";

/** Same as the coordinator's lifecycle, api/src/lifecycle.ts. */
export const MAX_TRACKED = 8;

/** Wall clock backstop past the chain deadline, in case the node stops producing blocks. */
const TASK_BACKSTOP_MS = Number(SOLUTION_WINDOW + FINALIZE_DEADLINE + 30n) * 1_000;

export type Outcome =
  | "finalized"
  | "finalized_passthrough"
  | "finalized_by_other"
  | "finalize_reverted"
  | "abandoned"
  | "not_best"
  | "window_missed"
  | "simulation_reverted"
  | "submit_reverted"
  | "empty"
  | "infeasible"
  | "error";

export interface BatchLine {
  batchId: bigint;
  intents: number;
  status: Outcome;
  submitTx: Hex | null;
  finalizeTx: Hex | null;
  savingsUsd: bigint;
  /** From hearing collect_closed to the submit receipt, null when nothing was sent. */
  closeToSubmitMs: number | null;
  detail: string;
}

export interface Summary {
  processed: number;
  counts: Record<string, number>;
  lines: BatchLine[];
  reconnects: number;
}

type Frame = StreamEvent | {code: string; message: string};

async function usable(c: PublicClient, k: Contracts, signed: SignedIntent[], solveEnd: bigint): Promise<{keep: SignedIntent[]; dropped: string[]}> {
  const keep: SignedIntent[] = [];
  const dropped: string[] = [];
  for (const s of signed) {
    // submitSolution refuses both since 0067794, with IntentExpired and IntentNonceUsed.
    if (BigInt(s.intent.validUntil) <= solveEnd) {
      dropped.push(`${s.intent.owner} nonce ${s.intent.nonce} expires by solveEnd`);
      continue;
    }
    const used = (await c.readContract({address: k.settlement, abi: settlementAbi(), functionName: "nonceUsed", args: [s.intent.owner, s.intent.nonce]})) as boolean;
    if (used) {
      dropped.push(`${s.intent.owner} nonce ${s.intent.nonce} already spent`);
      continue;
    }
    keep.push(s);
  }
  return {keep, dropped};
}

async function processBatch(c: PublicClient, account: HDAccount, k: Contracts, store: Store, batchId: bigint, closedAt: number, log: (line: string) => void): Promise<BatchLine> {
  const line: BatchLine = {batchId, intents: 0, status: "error", submitTx: null, finalizeTx: null, savingsUsd: 0n, closeToSubmitMs: null, detail: ""};
  const solveEnd = batchId + SOLUTION_WINDOW;

  const {body, signed} = await feed(batchId);
  line.intents = signed.length;
  if (signed.length === 0) return {...line, status: "empty", detail: "no intents"};
  if (!body.frozen) return {...line, status: "error", detail: "feed is not frozen after collect_closed"};

  const {keep, dropped} = await usable(c, k, signed, solveEnd);
  if (keep.length === 0) return {...line, status: "infeasible", detail: `every intent dropped, ${dropped.join("; ")}`};

  const block = await c.getBlockNumber();
  const {plan, inputs} = await solveAt(c, k, batchId, keep, account.address, block);
  const s = plan.solution;
  if (s.executions.length === 0) {
    return {...line, status: "infeasible", detail: plan.pairs.map((p) => `${p.base} ${p.mode}${p.reason ? ` (${p.reason})` : ""}`).join("; ") || "no pair"};
  }
  const pre = await preflight(c, k, s, inputs, solveEnd + 1n);
  if (pre.exposure.length > 0 || !pre.fee.ok) {
    return {...line, status: "infeasible", detail: `preflight refuses it, ${[...pre.exposure, pre.fee.ok ? "" : "fee over cap"].filter(Boolean).join(", ")}`};
  }

  const sent = await submit(c, account, k, s, store);
  if (sent.status === "window_missed" || sent.status === "simulation_reverted") return {...line, status: sent.status, detail: sent.reason};
  line.closeToSubmitMs = Math.round(performance.now() - closedAt);
  if (sent.status === "submit_reverted") {
    // No receipt inside the window still leaves a submit that may have landed,
    // so bestSolution decides, through the finalizer, rather than this guess.
    if (sent.tx === null || !sent.reason.startsWith("no receipt")) return {...line, status: "submit_reverted", submitTx: sent.tx, detail: sent.reason};
    line.closeToSubmitMs = null;
  }
  line.submitTx = sent.tx;
  if (sent.status === "not_best") return {...line, status: "not_best", detail: "another solution saved more"};

  const fin = await finalizeWon(c, account, k, s, store, log);
  return {...line, status: fin.status, finalizeTx: fin.tx, savingsUsd: fin.savingsUsd, detail: fin.result};
}

function withBackstop(task: Promise<BatchLine>, batchId: bigint): Promise<BatchLine> {
  let timer: NodeJS.Timeout;
  const backstop = new Promise<BatchLine>((resolve) => {
    timer = setTimeout(
      () => resolve({batchId, intents: 0, status: "abandoned", submitTx: null, finalizeTx: null, savingsUsd: 0n, closeToSubmitMs: null, detail: "task outlived its deadline on the wall clock backstop"}),
      TASK_BACKSTOP_MS,
    );
    timer.unref();
  });
  return Promise.race([task, backstop]).finally(() => clearTimeout(timer));
}

export function describeLine(l: BatchLine): string {
  return [
    `batch ${l.batchId}`,
    `intents ${l.intents}`,
    `status ${l.status}`,
    `submit ${l.submitTx ?? "-"}`,
    `finalize ${l.finalizeTx ?? "-"}`,
    `savings ${l.savingsUsd}`,
    `close_to_submit_ms ${l.closeToSubmitMs ?? "-"}`,
    l.detail ? `detail ${l.detail}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export async function run(opts: {durationMinutes?: number; log?: (line: string) => void} = {}): Promise<Summary> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const c = client();
  const account = solverAccount();
  const settlement = settlementAddress();
  const k = await contracts(c, settlement);
  const ready = await assertReady(c, k, account.address);
  const chainId = await c.getChainId();
  const store = new Store(storeDir(chainId, settlement));
  log(`solver ${account.address}, bond ${ready.bonded}, settlement ${settlement}, store ${store.dir}`);

  const summary: Summary = {processed: 0, counts: {}, lines: [], reconnects: 0};
  const inflight = new Map<bigint, Promise<void>>();
  const seen = new Set<string>();
  const record = (l: BatchLine) => {
    summary.processed += 1;
    summary.counts[l.status] = (summary.counts[l.status] ?? 0) + 1;
    summary.lines.push(l);
    log(describeLine(l));
  };
  const track = (batchId: bigint, task: Promise<BatchLine>) => {
    const p = withBackstop(
      task.catch((error) => ({batchId, intents: 0, status: "error" as const, submitTx: null, finalizeTx: null, savingsUsd: 0n, closeToSubmitMs: null, detail: (error as Error).message.split("\n")[0]!})),
      batchId,
    )
      .then(record)
      .finally(() => inflight.delete(batchId));
    inflight.set(batchId, p);
  };

  for (const r of await recover(c, account, k, store, log)) {
    seen.add(String(r.batchId));
    track(
      r.batchId,
      r.outcome.then((o) => ({batchId: r.batchId, intents: 0, status: o.status, submitTx: null, finalizeTx: "tx" in o ? o.tx : null, savingsUsd: "savingsUsd" in o ? o.savingsUsd : 0n, closeToSubmitMs: null, detail: `recovered, ${o.result}`})),
    );
  }

  const start = (await c.getBlock()).timestamp;
  const endAt = opts.durationMinutes === undefined ? null : start + BigInt(Math.round(opts.durationMinutes * 60));
  if (endAt !== null) log(`running until chain time ${endAt}, ${opts.durationMinutes} minutes from ${start}`);

  let stopping = false;
  let ws: WebSocket | null = null;
  let stopped: () => void = () => {};
  const finished = new Promise<void>((resolve) => (stopped = resolve));

  const onFrame = (f: Frame) => {
    if (!("type" in f)) {
      log(`stream error ${f.code}: ${f.message}`);
      return;
    }
    if (f.type === "batch.opened" && f.data.batchId !== null) log(`batch ${f.data.batchId} open, session ${f.data.session}`);
    if (f.type !== "batch.collect_closed" || stopping) return;
    const id = f.data.batchId;
    if (seen.has(id)) return;
    seen.add(id);
    const batchId = BigInt(id);
    if (inflight.size >= MAX_TRACKED) {
      record({batchId, intents: f.data.intentCount, status: "abandoned", submitTx: null, finalizeTx: null, savingsUsd: 0n, closeToSubmitMs: null, detail: `${MAX_TRACKED} batches already in flight`});
      return;
    }
    track(batchId, processBatch(c, account, k, store, batchId, performance.now(), log));
  };

  let delay = 1_000;
  const connect = () => {
    if (stopping) return;
    const socket = new WebSocket(`${API.replace(/^http/, "ws")}/v1/stream`);
    ws = socket;
    socket.addEventListener("open", () => {
      delay = 1_000;
      socket.send(JSON.stringify({type: "subscribe", topics: ["batch.opened", "batch.collect_closed"]}));
    });
    socket.addEventListener("message", (e) => onFrame(JSON.parse(String(e.data)) as Frame));
    socket.addEventListener("close", () => {
      if (stopping) return;
      summary.reconnects += 1;
      log(`stream closed, reconnecting in ${delay / 1_000}s (reconnect ${summary.reconnects})`);
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    });
    socket.addEventListener("error", () => {});
  };
  connect();

  const stop = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log(`stopping, ${why}. waiting on ${inflight.size} batches in flight`);
    (ws as WebSocket | null)?.close();
    await Promise.all(inflight.values());
    stopped();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  if (endAt !== null) {
    // One watcher for the whole run, resolved by the block that passes endAt.
    untilBlock(c, (ts) => ts >= endAt, endAt + 3_600n)
      .then(() => stop(`duration reached at chain time ${endAt}`))
      .catch((error) => stop(`block watcher failed, ${(error as Error).message.split("\n")[0]}`));
  }

  await finished;
  return summary;
}

export function describeSummary(s: Summary): string {
  const counts = Object.entries(s.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `  ${k.padEnd(20)} ${v}`);
  const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
  const latencies = s.lines.map((l) => l.closeToSubmitMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const pct = (p: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : null);
  return [
    `batches processed    ${s.processed}`,
    ...counts,
    `sum of statuses      ${total}${total === s.processed ? "" : " MISMATCH"}`,
    `stream reconnects    ${s.reconnects}`,
    `close to submit p50  ${pct(50) ?? "-"} ms`,
    `close to submit p99  ${pct(99) ?? "-"} ms`,
  ].join("\n");
}
