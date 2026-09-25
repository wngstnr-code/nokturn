// F27, the four public metrics, by the formulas in docs/interfaces.md section 10
// and from indexed events only, never from what a solver claimed.
//
//   savings_bps          = sum fills.savingsUsd / sum notional x 10000
//   netting_ratio        = sum batches.nettedUsd / (nettedUsd + routedUsd)
//   improvement_vs_venue = sum (executedBuy - baselineBuy) / sum baselineBuy
//   uptime               = settled batches / batches that had a winner
//
// uptime here counts only batches that had a winning solution. A batch nobody
// submitted to is not a failure of the settlement path, it is an empty batch,
// and counting it would make the number measure traffic rather than reliability.
//
// improvement_vs_venue sums raw token units across tokens, exactly as the
// formula is written. With one quote asset and one stock per fill it reads as
// the average relative improvement weighted by baseline size.

import type {Queryable} from "./db.ts";

export interface MetricInputs {
  fills: {executedBuy: bigint; baselineBuy: bigint; savingsUsd: bigint}[];
  batches: {outcome: string; nettedUsd: bigint; routedUsd: bigint}[];
  /** Batches with at least one accepted SolutionSubmitted. */
  batchesWithWinner: number;
}

export interface Metrics {
  savingsTotalUsd: string;
  notionalUsd: string;
  /** Basis points, as decimal strings with the same floor division throughout. */
  savingsBps: string;
  nettingRatioBps: string;
  improvementVsVenueBps: string;
  uptimeBps: string;
  settledBatches: number;
  batchesWithWinner: number;
}

const ratioBps = (num: bigint, den: bigint) => (den === 0n ? "0" : String((num * 10_000n) / den));

export function computeMetrics(m: MetricInputs): Metrics {
  const savings = m.fills.reduce((s, f) => s + f.savingsUsd, 0n);
  const settled = m.batches.filter((b) => b.outcome === "settled");
  const netted = settled.reduce((s, b) => s + b.nettedUsd, 0n);
  const routed = settled.reduce((s, b) => s + b.routedUsd, 0n);
  const gain = m.fills.reduce((s, f) => s + (f.executedBuy - f.baselineBuy), 0n);
  const base = m.fills.reduce((s, f) => s + f.baselineBuy, 0n);
  return {
    savingsTotalUsd: String(savings),
    notionalUsd: String(netted + routed),
    savingsBps: ratioBps(savings, netted + routed),
    nettingRatioBps: ratioBps(netted, netted + routed),
    improvementVsVenueBps: ratioBps(gain, base),
    uptimeBps: ratioBps(BigInt(settled.length), BigInt(m.batchesWithWinner)),
    settledBatches: settled.length,
    batchesWithWinner: m.batchesWithWinner,
  };
}

export async function loadMetrics(q: Queryable, deployment: string): Promise<Metrics> {
  const d = [deployment.toLowerCase()];
  const [fills, batches, winners] = await Promise.all([
    q.query("SELECT executed_buy, baseline_buy, savings_usd FROM fills WHERE deployment = $1", d),
    q.query("SELECT outcome, coalesce(netted_usd, 0) AS netted_usd, coalesce(routed_usd, 0) AS routed_usd FROM batches WHERE deployment = $1", d),
    q.query("SELECT count(DISTINCT batch_id)::int AS n FROM solutions WHERE deployment = $1 AND accepted", d),
  ]);
  return computeMetrics({
    fills: fills.rows.map((r) => ({executedBuy: BigInt(r.executed_buy), baselineBuy: BigInt(r.baseline_buy), savingsUsd: BigInt(r.savings_usd)})),
    batches: batches.rows.map((r) => ({outcome: r.outcome, nettedUsd: BigInt(r.netted_usd), routedUsd: BigInt(r.routed_usd)})),
    batchesWithWinner: winners.rows[0].n,
  });
}
