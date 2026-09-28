// F28. The indexed rows against direct contract reads at one pinned block.
//
//   node indexer/src/index.ts --reconcile [--at-block <n>]
//
// The block defaults to the indexer's own checkpoint, so both sides describe the
// same chain. Every check prints both numbers, and one difference makes the
// process exit non zero. Nothing is rounded before it is compared.

import {decodeEventLog, type Address, type Hex, type PublicClient} from "viem";
import {loadAbi} from "./abi.ts";
import type {Queryable} from "./db.ts";
import type {Deployment} from "./ingest.ts";

/**
 * The difference between the sum of IntentSettled.savingsUsd and
 * BatchSettled.totalSavingsUsd that is fine by design. It is zero because both
 * floor divide the same term, ((executedBuy - baselineQuotes[k]) * price) / WAD,
 * once per execution, ClearingVerifier.verify for the total and
 * Settlement._emitFills for each fill. A contract change that rounds them
 * differently must raise this here, with the reason, not in the comparison.
 */
export const SAVINGS_SUM_TOLERANCE_WEI = 0n;

export const BASELINE_SAMPLE = 10;
/** Fixed, so two runs over the same rows sample the same fills. */
export const BASELINE_SEED = 20260925;

export type CheckStatus = "match" | "differ" | "unreadable";

export interface Check {
  check: string;
  subject: string;
  db: string;
  chain: string;
  status: CheckStatus;
  note?: string;
}

export interface ChainReader {
  finalized(batchId: bigint): Promise<boolean>;
  best(batchId: bigint): Promise<{hash: string; savings: bigint; solver: string}>;
  /** BatchSettled as the receipt of txHash holds it, or null when that transaction emitted none. */
  batchSettled(txHash: string, batchId: bigint): Promise<{intentCount: bigint; totalSavingsUsd: bigint} | null>;
  stats(solver: string): Promise<{batchesWon: bigint; savingsGeneratedUsd: bigint; slashCount: bigint}>;
  tokenAllowed(token: string): Promise<boolean>;
  /** quoteFromState at a block. Throws when the node no longer holds that state. */
  quote(sellToken: string, buyToken: string, amount: bigint, blockNumber: bigint): Promise<bigint>;
}

const lower = (v: unknown) => String(v).toLowerCase();

function compare(check: string, subject: string, db: unknown, chain: unknown, note?: string): Check {
  return {check, subject, db: String(db), chain: String(chain), status: lower(db) === lower(chain) ? "match" : "differ", ...(note ? {note} : {})};
}

/** mulberry32, small and seedable, so the sample is the same every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample<T>(rows: T[], n: number, seed: number): T[] {
  const copy = [...rows];
  const next = rng(seed);
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

export interface ReconcileOptions {
  solvers?: string[];
  sampleSize?: number;
  seed?: number;
}

export async function reconcile(q: Queryable, chain: ChainReader, deployment: string, at: bigint, opts: ReconcileOptions = {}): Promise<Check[]> {
  const dep = deployment.toLowerCase();
  const upTo = [dep, String(at)];
  const out: Check[] = [];

  const batches = (await q.query("SELECT * FROM batches WHERE deployment = $1 AND block_number <= $2 ORDER BY batch_id", upTo)).rows;
  for (const b of batches) {
    const id = BigInt(b.batch_id);
    const subject = `batch ${id}`;
    // Every outcome the indexer records is a closing event, so each one means finalized.
    const closed = await chain.finalized(id);
    out.push({check: "batches.outcome", subject, db: String(b.outcome), chain: closed ? "finalized" : "not finalized", status: closed ? "match" : "differ"});

    const best = await chain.best(id);
    if (b.outcome === "settled") {
      out.push(compare("batches.solver", subject, b.solver, best.solver));
      out.push(compare("batches.savings_usd", subject, b.savings_usd, best.savings));

      const settled = await chain.batchSettled(String(b.tx_hash), id);
      const fills = (await q.query("SELECT count(*)::int AS n, coalesce(sum(savings_usd), 0)::text AS s FROM fills WHERE deployment = $1 AND batch_id = $2 AND block_number <= $3", [dep, String(id), String(at)])).rows[0];
      if (!settled) {
        out.push({check: "count(fills)", subject, db: String(fills.n), chain: "no BatchSettled in the closing transaction", status: "differ"});
        continue;
      }
      out.push(compare("count(fills)", subject, fills.n, settled.intentCount));
      const sum = BigInt(fills.s);
      const gap = sum > settled.totalSavingsUsd ? sum - settled.totalSavingsUsd : settled.totalSavingsUsd - sum;
      out.push({
        check: "sum(fills.savings_usd)",
        subject,
        db: String(sum),
        chain: String(settled.totalSavingsUsd),
        status: gap <= SAVINGS_SUM_TOLERANCE_WEI ? "match" : "differ",
        ...(gap > 0n ? {note: `off by ${gap} wei, tolerance ${SAVINGS_SUM_TOLERANCE_WEI}`} : {}),
      });
    } else {
      out.push({check: "batches.outcome", subject, db: `${b.outcome}, ${b.reason}`, chain: best.hash === `0x${"0".repeat(64)}` ? "no best solution" : `best ${best.hash} by ${best.solver}`, status: best.hash === `0x${"0".repeat(64)}` ? "differ" : "match", note: "a batch closes only with a best solution on record"});
    }
  }

  // The other direction. A batch the chain closed that the indexer never saw.
  const seen = new Set(batches.map((b) => String(b.batch_id)));
  const submitted = (await q.query("SELECT DISTINCT batch_id FROM solutions WHERE deployment = $1 AND block_number <= $2 ORDER BY batch_id", upTo)).rows;
  for (const s of submitted) {
    if (seen.has(String(s.batch_id))) continue;
    const closed = await chain.finalized(BigInt(s.batch_id));
    out.push({check: "batches row", subject: `batch ${s.batch_id}`, db: "no batches row", chain: closed ? "finalized" : "not finalized", status: closed ? "differ" : "match", note: "a solution was submitted, so an open batch is fine and a closed one must be indexed"});
  }

  const solvers = new Set((opts.solvers ?? []).map(lower));
  for (const r of (await q.query("SELECT DISTINCT solver FROM solvers WHERE deployment = $1 AND block_number <= $2", upTo)).rows) solvers.add(lower(r.solver));
  for (const solver of [...solvers].sort()) {
    const score = (await q.query("SELECT batches_won, savings_usd FROM solvers WHERE deployment = $1 AND block_number <= $2 AND lower(solver) = $3 AND event = 'score' ORDER BY block_number DESC, log_index DESC LIMIT 1", [...upTo, solver])).rows[0];
    const slashes = (await q.query("SELECT count(*)::int AS n FROM solvers WHERE deployment = $1 AND block_number <= $2 AND lower(solver) = $3 AND event = 'slashed'", [...upTo, solver])).rows[0].n;
    const stats = await chain.stats(solver);
    out.push(compare("solvers.batches_won", solver, score?.batches_won ?? 0, stats.batchesWon));
    out.push(compare("solvers.savings_usd", solver, score?.savings_usd ?? 0, stats.savingsGeneratedUsd));
    out.push(compare("count(solvers slashed)", solver, slashes, stats.slashCount));
  }

  const listed = (await q.query("SELECT DISTINCT ON (args->>'token') args->>'token' AS token, (args->>'allowed')::boolean AS allowed FROM logs WHERE deployment = $1 AND block_number <= $2 AND event = 'TokenAllowlisted' ORDER BY args->>'token', block_number DESC, log_index DESC", upTo)).rows;
  for (const t of listed) out.push(compare("logs TokenAllowlisted", String(t.token), t.allowed, await chain.tokenAllowed(String(t.token))));

  // The block the verifier read is the parent of the winning submitSolution,
  // the same rule the receipt's verifyBaseline uses.
  const fills = (
    await q.query(
      `SELECT f.batch_id, f.intent_hash, f.sell_token, f.buy_token, f.executed_sell, f.baseline_buy, f.block_number, s.block_number AS submit_block
         FROM fills f
         LEFT JOIN batch_solutions w ON w.deployment = f.deployment AND w.batch_id = f.batch_id
         LEFT JOIN solutions s ON s.deployment = f.deployment AND s.batch_id = f.batch_id AND s.solution_hash = w.solution_hash
        WHERE f.deployment = $1 AND f.block_number <= $2
        ORDER BY f.block_number, f.log_index`,
      upTo,
    )
  ).rows;
  // Settlement holds the baseline per direction, parameter.md 4C. The sum of a
  // direction's baselines may not fall under the venue's quote on that
  // direction's whole volume. How the sum is split between fills is the
  // solver's choice, a pro rata share on a routed batch, so a fill's own quote
  // is not what the chain guarantees and is not what is compared here.
  for (const d of sample(directions(fills), opts.sampleSize ?? BASELINE_SAMPLE, opts.seed ?? BASELINE_SEED)) {
    const subject = `batch ${d.batchId} ${d.sellToken} to ${d.buyToken}, ${d.fills} fills at ${d.block}`;
    try {
      const floor = await chain.quote(d.sellToken, d.buyToken, d.executedSell, d.block);
      out.push({check: "sum(fills.baseline_buy) per direction", subject, db: String(d.baselineBuy), chain: String(floor), status: d.baselineBuy >= floor ? "match" : "differ", note: "at or above the venue quote on the direction's volume"});
    } catch (error) {
      out.push({check: "sum(fills.baseline_buy) per direction", subject, db: String(d.baselineBuy), chain: "unreadable", status: "unreadable", note: (error as Error).message.split("\n")[0]});
    }
  }
  return out;
}

interface Direction {
  batchId: string;
  sellToken: string;
  buyToken: string;
  block: bigint;
  fills: number;
  executedSell: bigint;
  baselineBuy: bigint;
}

/** Fills grouped the way Settlement._verify groups them, one entry per batch and direction. */
export function directions(fills: Record<string, unknown>[]): Direction[] {
  const byKey = new Map<string, Direction>();
  for (const f of fills) {
    const sellToken = String(f.sell_token).toLowerCase();
    const buyToken = String(f.buy_token).toLowerCase();
    const key = `${f.batch_id}:${sellToken}:${buyToken}`;
    const d = byKey.get(key) ?? {batchId: String(f.batch_id), sellToken, buyToken, block: BigInt(String(f.submit_block ?? f.block_number)) - 1n, fills: 0, executedSell: 0n, baselineBuy: 0n};
    d.fills += 1;
    d.executedSell += BigInt(String(f.executed_sell));
    d.baselineBuy += BigInt(String(f.baseline_buy));
    byKey.set(key, d);
  }
  return [...byKey.values()];
}

export function viemReader(c: PublicClient, d: Deployment, at: bigint, adapter: Address): ChainReader {
  const settlementAbi = loadAbi("Settlement");
  const registryAbi = loadAbi("SolverRegistry");
  const adapterAbi = loadAbi("UniswapV3Adapter");
  const registry = [...d.contracts].find(([, key]) => key === "solvers")?.[0] as Address | undefined;
  const settlement = d.settlement as Address;
  const blockNumber = at;
  return {
    async finalized(batchId) {
      return (await c.readContract({address: settlement, abi: settlementAbi, functionName: "finalized", args: [batchId], blockNumber})) as boolean;
    },
    async best(batchId) {
      const [hash, savings, solver] = (await c.readContract({address: settlement, abi: settlementAbi, functionName: "bestSolution", args: [batchId], blockNumber})) as [Hex, bigint, Address];
      return {hash: hash.toLowerCase(), savings, solver: solver.toLowerCase()};
    },
    async batchSettled(txHash, batchId) {
      const receipt = await c.getTransactionReceipt({hash: txHash as Hex});
      for (const l of receipt.logs) {
        if (lower(l.address) !== d.settlement) continue;
        try {
          const e = decodeEventLog({abi: settlementAbi, topics: l.topics, data: l.data});
          if (e.eventName !== "BatchSettled") continue;
          const a = e.args as unknown as {batchId: bigint; intentCount: bigint; totalSavingsUsd: bigint};
          if (a.batchId === batchId) return {intentCount: a.intentCount, totalSavingsUsd: a.totalSavingsUsd};
        } catch {
          continue;
        }
      }
      return null;
    },
    async stats(solver) {
      if (!registry) throw new Error("the deployment record names no solver registry");
      const [batchesWon, savingsGeneratedUsd, , slashCount] = (await c.readContract({address: registry, abi: registryAbi, functionName: "stats", args: [solver as Address], blockNumber})) as [bigint, bigint, bigint, bigint];
      return {batchesWon, savingsGeneratedUsd, slashCount};
    },
    async tokenAllowed(token) {
      return (await c.readContract({address: settlement, abi: settlementAbi, functionName: "tokenAllowed", args: [token as Address], blockNumber})) as boolean;
    },
    async quote(sellToken, buyToken, amount, block) {
      return (await c.readContract({address: adapter, abi: adapterAbi, functionName: "quoteFromState", args: [sellToken as Address, buyToken as Address, amount], blockNumber: block})) as bigint;
    },
  };
}

export function report(checks: Check[]): string {
  const width = (k: keyof Check) => Math.max(...checks.map((c) => String(c[k] ?? "").length), k.length);
  const cols: (keyof Check)[] = ["status", "check", "subject", "db", "chain"];
  const line = (c: Partial<Check>) => cols.map((k) => String(c[k] ?? "").padEnd(width(k))).join("  ") + (c.note ? `  ${c.note}` : "");
  const counts = {match: 0, differ: 0, unreadable: 0};
  for (const c of checks) counts[c.status] += 1;
  return [line({status: "status" as CheckStatus, check: "check", subject: "subject", db: "db", chain: "chain"}), ...checks.map(line), "", `${checks.length} checks, ${counts.match} match, ${counts.differ} differ, ${counts.unreadable} unreadable`].join("\n");
}
