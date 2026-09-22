// From one decoded log to the rows it puts in the domain tables.
//
// Pure. Every row comes from the event's own arguments and its provenance, and
// nothing is looked up or guessed. The store applies the ops, and the same ops
// rebuild every domain table from the logs table after a revert, which is why a
// row that later events update, an auction, can be rolled back at all.

import {hexToString, type Hex} from "viem";

export interface DecodedLog {
  chainId: number;
  deployment: string;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
  txHash: string;
  logIndex: number;
  address: string;
  contract: string;
  event: string;
  /** JSON safe. uints as decimal strings, addresses and hashes lowercase. */
  args: Record<string, unknown>;
}

export type Row = Record<string, string | number | boolean | null>;

export type Op =
  /** Insert, and leave an existing row with the same key alone. */
  | {kind: "insert"; table: string; row: Row}
  /** Insert, or overwrite only the columns this row names. */
  | {kind: "upsert"; table: string; row: Row}
  /** Update the rows matching key, if any exist. */
  | {kind: "merge"; table: string; key: Row; set: Row};

const PROVENANCE_KEY = ["chain_id", "tx_hash", "log_index"];

/** Conflict keys, matching the primary keys in sql/001_init.sql. */
export const KEYS: Record<string, string[]> = {
  batches: ["deployment", "batch_id"],
  auctions: ["deployment", "auction_id"],
  batch_solutions: ["deployment", "batch_id"],
  fills: PROVENANCE_KEY,
  prices: PROVENANCE_KEY,
  indicative: PROVENANCE_KEY,
  closing_prints: PROVENANCE_KEY,
  closing_prints_withheld: PROVENANCE_KEY,
  solvers: PROVENANCE_KEY,
  sessions: PROVENANCE_KEY,
  solutions: PROVENANCE_KEY,
  venue_routes: PROVENANCE_KEY,
  collection_failures: PROVENANCE_KEY,
};

export const DOMAIN_TABLES = Object.keys(KEYS).filter((t) => t !== "batch_solutions");

/** bytes32 reasons are short ASCII strings right padded with zeros. */
export function reasonText(value: unknown): string {
  const hex = String(value) as Hex;
  try {
    return hexToString(hex, {size: 32}).replace(/\0+$/, "");
  } catch {
    return hex;
  }
}

export function provenance(l: DecodedLog): Row {
  return {
    chain_id: l.chainId,
    block_number: String(l.blockNumber),
    block_timestamp: String(l.blockTimestamp),
    tx_hash: l.txHash,
    log_index: l.logIndex,
  };
}

const s = (v: unknown) => String(v);

/**
 * ClearingPrice carries price and refPrice, and the deviation is derived here for
 * display. Floor divided, which is fine off the limit checking path.
 */
export function deviationBps(price: bigint, refPrice: bigint): bigint {
  if (refPrice === 0n) return 0n;
  const diff = price > refPrice ? price - refPrice : refPrice - price;
  return (diff * 10_000n) / refPrice;
}

export function project(l: DecodedLog): Op[] {
  const a = l.args;
  const d = {deployment: l.deployment};
  const p = provenance(l);
  switch (`${l.contract}.${l.event}`) {
    case "Settlement.BatchSettled":
      // After BatchPassthrough "savings below threshold" when the same finalize
      // settles anyway, a routed batch that saved nothing. Settled decides, and
      // the passthrough reason stays on the row as a note.
      return [{kind: "upsert", table: "batches", row: {...d, batch_id: s(a.batchId), outcome: "settled", session: Number(a.session), intent_count: Number(a.intentCount), netted_usd: s(a.nettedVolumeUsd), routed_usd: s(a.routedVolumeUsd), savings_usd: s(a.totalSavingsUsd), solver_fee_usd: s(a.solverFeeUsd), protocol_fee_usd: s(a.protocolFeeUsd), solver: s(a.solver), ...p}}];
    case "Settlement.BatchPassthrough": {
      const reason = s(a.reason);
      const outcome = reason === "winner never finalized" ? "expired" : "passthrough";
      return [{kind: "insert", table: "batches", row: {...d, batch_id: s(a.batchId), outcome, reason, intent_count: Number(a.intentCount), ...p}}];
    }
    case "Settlement.IntentSettled":
      return [{kind: "insert", table: "fills", row: {...d, batch_id: s(a.batchId), intent_hash: s(a.intentHash), owner: s(a.owner), sell_token: s(a.sellToken), buy_token: s(a.buyToken), executed_sell: s(a.executedSell), executed_buy: s(a.executedBuy), baseline_buy: s(a.baselineBuy), savings_usd: s(a.savingsUsd), ...p}}];
    case "Settlement.ClearingPrice":
      return [{kind: "insert", table: "prices", row: {...d, batch_id: s(a.batchId), token: s(a.token), price: s(a.price), ref_price: s(a.refPrice), deviation_bps: String(deviationBps(BigInt(s(a.price)), BigInt(s(a.refPrice)))), ...p}}];
    case "Settlement.SolutionSubmitted":
      return [{kind: "insert", table: "solutions", row: {...d, batch_id: s(a.batchId), solver: s(a.solver), solution_hash: s(a.hash), claimed_savings: s(a.claimedSavings), accepted: true, rejection_reason: null, ...p}}];
    case "Settlement.SolutionRejected":
      // Only "not the best" ever reaches the chain. submitSolution emits
      // "savings mismatch" and then reverts, which takes the event with it, so a
      // solution that reverted leaves no row here and none is invented for it.
      return [{kind: "merge", table: "solutions", key: {...d, tx_hash: l.txHash, solver: s(a.solver)}, set: {accepted: false, rejection_reason: reasonText(a.reason)}}];
    case "Settlement.VenueRouted":
      return [{kind: "insert", table: "venue_routes", row: {...d, batch_id: s(a.batchId), adapter: s(a.adapter), token_in: s(a.tokenIn), token_out: s(a.tokenOut), amount_in: s(a.amountIn), amount_out: s(a.amountOut), ...p}}];
    case "Settlement.IntentCollectionFailed":
      return [{kind: "insert", table: "collection_failures", row: {...d, batch_id: s(a.batchId), owner: s(a.owner), intent_index: Number(a.intentIndex), ...p}}];

    case "AuctionHouse.AuctionOpened":
      return [{kind: "insert", table: "auctions", row: {...d, auction_id: s(a.auctionId), token: s(a.token), kind: Number(a.kind), cross_at: s(a.crossAt), status: "open", extensions: 0, ...p, last_block_number: p.block_number, last_tx_hash: l.txHash, last_log_index: l.logIndex}}];
    case "AuctionHouse.AuctionExtended":
      return [auctionMerge(l, {extensions: Number(a.extensionCount), collar_bps: Number(a.newCollarBps)})];
    case "AuctionHouse.AuctionFrozen":
      return [auctionMerge(l, {status: "frozen", committed_intents: s(a.committedIntents), escrowed_value: s(a.escrowedValue)})];
    case "AuctionHouse.CrossExecuted":
      return [auctionMerge(l, {status: "crossed", price: s(a.price), volume: s(a.volume), participants: Number(a.participants)})];
    case "AuctionHouse.AuctionAborted":
      return [auctionMerge(l, {status: "aborted", abort_reason: reasonText(a.reason)})];
    case "AuctionHouse.IndicativePublished":
      return [{kind: "insert", table: "indicative", row: {...d, auction_id: s(a.auctionId), token: s(a.token), ts: String(l.blockTimestamp), price: s(a.indicativePrice), imbalance: s(a.imbalance), matched_volume: s(a.matchedVolume), ...p}}];
    case "AuctionHouse.ClosingPrintPublished":
      return [{kind: "insert", table: "closing_prints", row: {...d, token: s(a.token), day: s(a.day), price: s(a.price), volume: s(a.volume), participants: Number(a.participants), sufficient: Boolean(a.sufficient), ...p}}];
    case "AuctionHouse.ClosingPrintWithheld":
      return [{kind: "insert", table: "closing_prints_withheld", row: {...d, token: s(a.token), day: s(a.day), reason: reasonText(a.reason), volume: s(a.volume), participants: Number(a.participants), ...p}}];

    case "SolverRegistry.SolverBonded":
      return [solverRow(l, "bonded", {bonded_total: s(a.total)})];
    case "SolverRegistry.SolverScoreUpdated":
      return [solverRow(l, "score", {batches_won: s(a.batchesWon), savings_usd: s(a.savingsGeneratedUsd)})];
    case "SolverRegistry.SolverSlashed":
      return [solverRow(l, "slashed", {slash_amount: s(a.amount), slash_reason: reasonText(a.reason)})];
    case "SolverRegistry.SolverUnbondRequested":
      return [solverRow(l, "unbond_requested", {})];

    case "SessionManager.SessionChanged":
      return [{kind: "insert", table: "sessions", row: {...d, kind: "changed", ts: s(a.timestamp), from_session: Number(a.from), to_session: Number(a.to), ...p}}];
    case "SessionManager.TokenProtective":
      return [{kind: "insert", table: "sessions", row: {...d, kind: "protective", ts: String(l.blockTimestamp), token: s(a.token), reason: reasonText(a.reason), ...p}}];
    case "SessionManager.TokenProtectiveCleared":
      return [{kind: "insert", table: "sessions", row: {...d, kind: "cleared", ts: String(l.blockTimestamp), token: s(a.token), healthy_updates: Number(a.healthyUpdates), ...p}}];

    default:
      // Everything else, the oracle's OracleStale and OracleDisagreement and
      // AuctionHouse's CommitmentDropped among them, lives in the logs table,
      // which is where the failure screen reads it from.
      return [];
  }
}

function auctionMerge(l: DecodedLog, set: Row): Op {
  return {kind: "merge", table: "auctions", key: {deployment: l.deployment, auction_id: String(l.args.auctionId)}, set: {...set, last_block_number: String(l.blockNumber), last_tx_hash: l.txHash, last_log_index: l.logIndex}};
}

function solverRow(l: DecodedLog, event: string, fields: Row): Op {
  return {kind: "insert", table: "solvers", row: {deployment: l.deployment, solver: String(l.args.solver), event, ...fields, ...provenance(l)}};
}
