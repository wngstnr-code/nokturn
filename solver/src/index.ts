// The reference solver, dry run only.
//
//   node solver/src/index.ts --once
//
// Follows one batch through WS /v1/stream, solves it when collection closes,
// and asks every check that can refuse the solution through eth_call. Nothing
// is sent. Sending and finalize are F21, and a solver that submits has to keep
// the Solution byte for byte until finalize, which this one does not need yet.

import {fileURLToPath} from "node:url";
import type {Address, Hex, PublicClient} from "viem";
import type {BatchIntentsResponse, StreamEvent} from "../../packages/shared/api-types.ts";
import {USDG} from "../../packages/shared/addresses.ts";
import {assertBare, solverAccount} from "./account.ts";
import {API, client, contracts, settlementAddress, type Contracts} from "./chain.ts";
import type {Intent} from "./solution.ts";
import {solutionHash} from "./solution.ts";
import {readInputs, solve, type Plan, type SignedIntent} from "./solve.ts";
import {preflight, simulateSubmit, verifyOnChain, type Preflight} from "./simulate.ts";

export interface Report {
  batchId: bigint;
  block: bigint;
  intents: number;
  plan: Plan | null;
  hash: Hex | null;
  savings: bigint;
  verify: string;
  preflight: Preflight | null;
  simulation: string;
  /** From hearing collect_closed to the simulation answering. */
  closeToSimulatedMs: number;
}

type Frame = StreamEvent | {code: string; message: string};

function toIntent(p: BatchIntentsResponse["intents"][number]["intent"]): Intent {
  return {
    owner: p.owner,
    receiver: p.receiver,
    sellToken: p.sellToken,
    buyToken: p.buyToken,
    sellAmount: BigInt(p.sellAmount),
    minBuyAmount: BigInt(p.minBuyAmount),
    validAfter: Number(p.validAfter),
    validUntil: Number(p.validUntil),
    flags: Number(p.flags),
    kind: Number(p.kind),
    maxDevFromRefBps: Number(p.maxDevFromRefBps),
    allowedSessions: Number(p.allowedSessions),
    batchSpan: Number(p.batchSpan),
    nonce: BigInt(p.nonce),
  };
}

async function feed(batchId: bigint): Promise<{body: BatchIntentsResponse; signed: SignedIntent[]}> {
  const res = await fetch(`${API}/v1/batches/${batchId}/intents`);
  if (!res.ok) throw new Error(`GET /v1/batches/${batchId}/intents answered ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as BatchIntentsResponse;
  return {body, signed: body.intents.map((s) => ({intent: toIntent(s.intent), signature: s.signature}))};
}

function tokensOf(signed: SignedIntent[]): Address[] {
  const set = new Map<string, Address>([[USDG.toLowerCase(), USDG as Address]]);
  for (const {intent} of signed) for (const t of [intent.sellToken, intent.buyToken]) set.set(t.toLowerCase(), t);
  return [...set.values()];
}

async function solveAt(c: PublicClient, k: Contracts, batchId: bigint, signed: SignedIntent[], solver: Address, block: bigint): Promise<{plan: Plan; inputs: Awaited<ReturnType<typeof readInputs>>}> {
  const inputs = await readInputs(c, k, batchId, tokensOf(signed), block);
  return {plan: await solve(c, k, batchId, signed, USDG as Address, solver, inputs), inputs};
}

/**
 * One batch, start to dry run. batchId is the batch to follow. Without it, the
 * batch the stream's snapshot names on subscribe, so the solver never derives
 * a batchId of its own.
 */
export async function once(opts: {batchId?: bigint; timeoutMs?: number; log?: (line: string) => void} = {}): Promise<Report> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const c = client();
  const solver = solverAccount().address;
  await assertBare(c, solver);
  const settlement = settlementAddress();

  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/v1/stream`);
  const frames: Frame[] = [];
  let wake: (() => void) | null = null;
  ws.addEventListener("message", (e) => {
    frames.push(JSON.parse(String(e.data)) as Frame);
    wake?.();
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(`cannot open ${API}/v1/stream. is the api running`)));
  });
  ws.send(JSON.stringify({type: "subscribe", topics: ["batch.opened", "batch.intent_added", "batch.collect_closed"]}));

  const deadline = performance.now() + (opts.timeoutMs ?? 180_000);
  const next = async (pred: (f: Frame) => boolean): Promise<Frame> => {
    for (;;) {
      const hit = frames.find(pred);
      if (hit) {
        frames.splice(frames.indexOf(hit), 1);
        return hit;
      }
      const left = deadline - performance.now();
      if (left <= 0) throw new Error("timed out waiting on the stream");
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, Math.min(left, 1_000)).unref();
      });
    }
  };

  try {
    let batchId = opts.batchId;
    while (batchId === undefined) {
      const f = await next((x) => "type" in x && x.type === "batch.opened");
      if ("type" in f && f.type === "batch.opened" && f.data.batchId !== null) batchId = BigInt(f.data.batchId);
    }
    log(`following batch ${batchId}`);

    // Ahead of the close, so the close only has to refresh prices and quotes.
    // The set can still grow, so nothing computed here is submitted.
    const warm = async () => {
      const {signed} = await feed(batchId!);
      if (signed.length === 0) return;
      const k = await contracts(c, settlement);
      const block = await c.getBlockNumber();
      const {plan} = await solveAt(c, k, batchId!, signed, solver, block);
      log(`  warm, ${signed.length} intents, ${plan.solution.executions.length} executions`);
    };

    for (;;) {
      const f = await next((x) => "type" in x && (x.type === "batch.intent_added" || x.type === "batch.collect_closed") && x.data.batchId === String(batchId));
      if ("type" in f && f.type === "batch.collect_closed") break;
      await warm().catch((error) => log(`  warm failed, ${(error as Error).message}`));
    }

    const closedAt = performance.now();
    const {body, signed} = await feed(batchId);
    if (!body.frozen) throw new Error(`feed for ${batchId} is not frozen after collect_closed`);
    const block = await c.getBlockNumber();
    const k = await contracts(c, settlement, block);
    const report: Report = {batchId, block, intents: signed.length, plan: null, hash: null, savings: 0n, verify: "-", preflight: null, simulation: "nothing to submit", closeToSimulatedMs: 0};
    if (signed.length === 0) return {...report, closeToSimulatedMs: Math.round(performance.now() - closedAt)};

    const {plan, inputs} = await solveAt(c, k, batchId, signed, solver, block);
    report.plan = plan;
    const s = plan.solution;
    if (s.executions.length === 0) return {...report, closeToSimulatedMs: Math.round(performance.now() - closedAt)};

    report.hash = solutionHash(s);
    report.savings = s.claimedSavings;
    report.preflight = await preflight(c, k, s, inputs, BigInt(body.solveEndsAt) + 1n);
    const verified = await verifyOnChain(c, k, s, inputs);
    report.verify = verified.ok ? (verified.savings === s.claimedSavings ? `ok, savings ${verified.savings}` : `MISMATCH, verify says ${verified.savings}`) : `reverts ${verified.error}`;

    if (report.preflight.exposure.length > 0 || !report.preflight.fee.ok) {
      report.simulation = `not simulated, preflight refuses it: ${[...report.preflight.exposure, report.preflight.fee.ok ? "" : "fee over cap"].filter(Boolean).join(", ")}`;
    } else {
      const now = (await c.getBlock()).timestamp;
      if (now <= BigInt(body.collectEndsAt) || now > BigInt(body.solveEndsAt)) {
        report.simulation = `outside the solution window, chain time ${now}, window (${body.collectEndsAt}, ${body.solveEndsAt}]`;
      } else {
        const sim = await simulateSubmit(c, k, s, solver);
        report.simulation = sim.ok ? `submitSolution would succeed at chain time ${now}` : `submitSolution reverts ${sim.error}`;
      }
    }
    report.closeToSimulatedMs = Math.round(performance.now() - closedAt);
    return report;
  } finally {
    ws.close();
  }
}

export function describeReport(r: Report): string {
  const pairs = r.plan?.pairs.map((p) => `${p.base} ${p.mode}${p.reason ? ` (${p.reason})` : ""}`).join("; ") ?? "-";
  return [
    `batch        ${r.batchId}`,
    `block        ${r.block}`,
    `intents      ${r.intents}, executed ${r.plan?.solution.executions.length ?? 0}, venue calls ${r.plan?.solution.venueCalls.length ?? 0}`,
    `pairs        ${pairs}`,
    `hash         ${r.hash ?? "-"}`,
    `savings      ${r.savings} (USD, 18 decimals)`,
    `verify       ${r.verify}`,
    `exposure     ${r.preflight ? r.preflight.exposure.join(", ") || "inside every cap" : "-"}`,
    `fee          ${r.preflight ? `withheld at least ${r.preflight.fee.withheldUsd}, cap ${r.preflight.fee.cap}` : "-"}`,
    `simulation   ${r.simulation}`,
    `close to sim ${r.closeToSimulatedMs} ms`,
    "no transaction was sent",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--once")) {
    console.error("usage: node solver/src/index.ts --once\nonly the dry run exists today. sending is F21.");
    process.exit(2);
  }
  once()
    .then((r) => console.log(describeReport(r)))
    .catch((error) => {
      console.error(`solver failed\n  ${(error as Error).message}`);
      process.exit(1);
    });
}
