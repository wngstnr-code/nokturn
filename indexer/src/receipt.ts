// The batch receipt, built only from indexed facts and one eth_call per fill.
//
// Every figure comes from an event, from the winning Solution in the finalize
// calldata, or from the chain at a named block. Where the chain holds nothing,
// the field is null, never zero and never a guess.

import {encodeFunctionData, type Address, type Hex} from "viem";
import type {
  ApiErrorCode,
  BaselineFloor,
  BatchReceipt,
  ClearingPriceRow,
  FillReceipt,
  Provenance,
  ProvenanceSource,
  SessionName,
  SolutionSummary,
  TokenRef,
  VenueRoute,
} from "../../packages/shared/api-types.ts";
import type {Session} from "../../packages/shared/types.ts";
import {loadAbi} from "./abi.ts";
import type {Queryable} from "./db.ts";

type Row = Record<string, unknown>;

export interface BatchFacts {
  batch: Row | null;
  fills: Row[];
  prices: Row[];
  solutions: Row[];
  venueRoutes: Row[];
  collectionFailures: Row[];
  winning: Row | null;
  /** baseline_quotes, the answers the indexer read while the state was still there. */
  quotes: Row[];
}

const FACT_TABLES = {
  fills: "fills",
  prices: "prices",
  solutions: "solutions",
  venueRoutes: "venue_routes",
  collectionFailures: "collection_failures",
} as const;

export async function loadFacts(q: Queryable, deployment: string, batchId: bigint): Promise<BatchFacts> {
  const args = [deployment.toLowerCase(), String(batchId)];
  const one = async (table: string) => (await q.query(`SELECT * FROM ${table} WHERE deployment = $1 AND batch_id = $2`, args)).rows[0] ?? null;
  const many = async (table: string) => (await q.query(`SELECT * FROM ${table} WHERE deployment = $1 AND batch_id = $2 ORDER BY block_number, log_index`, args)).rows;
  const [batch, winning, fills, prices, solutions, venueRoutes, collectionFailures, quotes] = await Promise.all([
    one("batches"),
    one("batch_solutions"),
    many(FACT_TABLES.fills),
    many(FACT_TABLES.prices),
    many(FACT_TABLES.solutions),
    many(FACT_TABLES.venueRoutes),
    many(FACT_TABLES.collectionFailures),
    q.query("SELECT * FROM baseline_quotes WHERE deployment = $1 AND batch_id = $2", args).then((r) => r.rows),
  ]);
  return {batch, winning, fills, prices, solutions, venueRoutes, collectionFailures, quotes};
}

export interface BaselineCall {
  sellToken: Address;
  buyToken: Address;
  amount: bigint;
  block: bigint;
}

/**
 * verifyBaseline reads the pool state the verifier read, which is the parent of
 * the block holding the winning submitSolution. Without a known winner, the
 * parent of the fill's own block.
 */
function quoteBlock(facts: BatchFacts, fill: Row): bigint {
  const winningSubmit = facts.winning ? facts.solutions.find((s) => same(s.solution_hash, facts.winning!.solution_hash)) : null;
  return winningSubmit ? big(winningSubmit.block_number) - 1n : big(fill.block_number) - 1n;
}

function directions(facts: BatchFacts) {
  const out = new Map<string, {sell: Address; buy: Address; block: bigint; fills: number; executedSell: bigint; baselineBuy: bigint}>();
  for (const f of facts.fills) {
    const sell = String(f.sell_token) as Address;
    const buy = String(f.buy_token) as Address;
    const key = `${sell}:${buy}`.toLowerCase();
    const d = out.get(key) ?? {sell, buy, block: quoteBlock(facts, f), fills: 0, executedSell: 0n, baselineBuy: 0n};
    d.fills += 1;
    d.executedSell += big(f.executed_sell);
    d.baselineBuy += big(f.baseline_buy);
    out.set(key, d);
  }
  return [...out.values()];
}

/** Every quoteFromState a receipt shows, one per fill and one per direction. The indexer reads these at settle. */
export function baselineCalls(facts: BatchFacts): BaselineCall[] {
  const calls = new Map<string, BaselineCall>();
  const add = (c: BaselineCall) => calls.set(quoteKey(c.sellToken, c.buyToken, c.amount, c.block), c);
  for (const f of facts.fills) add({sellToken: String(f.sell_token) as Address, buyToken: String(f.buy_token) as Address, amount: big(f.executed_sell), block: quoteBlock(facts, f)});
  for (const d of directions(facts)) add({sellToken: d.sell, buyToken: d.buy, amount: d.executedSell, block: d.block});
  return [...calls.values()];
}

const quoteKey = (sell: string, buy: string, amount: bigint, block: bigint, adapter = "") => `${adapter}:${sell}:${buy}:${amount}:${block}`.toLowerCase();

/** A quote, a revert, or a state the node no longer holds and the indexer never stored. */
type Quoted = bigint | "reverts" | "unavailable";

const shown = (q: Quoted) => (typeof q === "bigint" ? String(q) : q);

export interface TokenMeta {
  symbol: string;
  decimals: number;
  /** The allowlisted pool against the quote asset, from infra/chain.json. */
  pool?: string;
}

export interface ReceiptContext {
  chainId: number;
  source: ProvenanceSource;
  tokens: Map<string, TokenMeta>;
  quoteToken: string;
  explorer: string;
  rpcUrl: string;
  baselineAdapter: Address;
  session: Session;
  sessionName: SessionName;
  batchDurationSeconds: number;
  maxDeviationBps: number;
  /**
   * quoteFromState through eth_call at a block, or null when it reverts. Asked
   * only when baseline_quotes holds no answer, and a throw is taken as the node
   * having dropped that state.
   */
  quote: (sellToken: Address, buyToken: Address, amount: bigint, blockNumber: bigint) => Promise<bigint | null>;
  log?: (line: string) => void;
}

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const big = (v: unknown) => BigInt(String(v));

export function provenanceOf(r: Row, source: ProvenanceSource): Provenance {
  return {
    chainId: Number(r.chain_id),
    blockNumber: String(r.block_number),
    blockTimestamp: Number(r.block_timestamp),
    transactionHash: String(r.tx_hash) as Hex,
    logIndex: Number(r.log_index),
    source,
  };
}

function tokenRef(address: string, ctx: ReceiptContext): TokenRef {
  const meta = ctx.tokens.get(address.toLowerCase());
  return {
    address: address as Address,
    symbol: meta?.symbol ?? "unknown",
    decimals: meta?.decimals ?? 18,
    explorerUrl: `${ctx.explorer}/address/${address}`,
  };
}

/** Display path, not the limit checking path, so dividing here is fine. */
export function improvementBps(executedBuy: bigint, baselineBuy: bigint): string {
  if (baselineBuy === 0n) return "0";
  return String(((executedBuy - baselineBuy) * 10_000n) / baselineBuy);
}

export function nettingRatioBps(netted: bigint, routed: bigint): string {
  const notional = netted + routed;
  return notional === 0n ? "0" : String((netted * 10_000n) / notional);
}

/**
 * How much of each fill reached a venue. The chain does not say per fill, so it
 * is derived. The venue calls in one direction, tokenIn to tokenOut, are split
 * across that direction's fills pro rata to executedSell, floor divided, and the
 * rest of each fill is what met the other side. So nettedSell + routedSell is
 * executedSell exactly, and the floor leaves any remainder on the netted side.
 */
export function attribute(fills: {sellToken: string; buyToken: string; executedSell: bigint}[], routes: {tokenIn: string; tokenOut: string; amountIn: bigint}[]): {nettedSell: bigint; routedSell: bigint}[] {
  return fills.map((f) => {
    const routed = routes.filter((r) => same(r.tokenIn, f.sellToken) && same(r.tokenOut, f.buyToken)).reduce((s, r) => s + r.amountIn, 0n);
    const direction = fills.filter((g) => same(g.sellToken, f.sellToken) && same(g.buyToken, f.buyToken)).reduce((s, g) => s + g.executedSell, 0n);
    const share = direction === 0n ? 0n : (routed * f.executedSell) / direction;
    const routedSell = share > f.executedSell ? f.executedSell : share;
    return {nettedSell: f.executedSell - routedSell, routedSell};
  });
}

// The table keeps settled for a batch below the savings threshold, because its
// trades happened and metrics count it so. The API names it apart, so a screen
// never has to infer a fill at the venue price from a failure next to fills.
export function publicOutcome(outcome: string, reason: string | null): BatchReceipt["outcome"] {
  if (outcome === "settled" && reason === "savings below threshold") return "settled_at_venue";
  return outcome as BatchReceipt["outcome"];
}

const FAILURE_CODES: Record<string, ApiErrorCode> = {
  "winner never finalized": "WinnerNeverFinalized",
  "intent could not be collected": "IntentCollectionFailed",
};

interface SolutionJson {
  intents: {owner: string; receiver: string; sellToken: string; buyToken: string; sellAmount: string}[];
  executions: {intentIndex: string; executedSell: string; executedBuy: string}[];
  venueCalls: {adapter: string; tokenIn: string; tokenOut: string; amountIn: string; minOut: string}[];
}

export interface BuiltReceipt {
  receipt: BatchReceipt;
  /**
   * Directions whose summed baseline sits under the venue's quote on their
   * volume, or whose quote reverts, at the block the verifier read.
   * The rule Settlement enforces, so any entry here means the rows or the
   * chain disagree with what was accepted.
   */
  baselineMismatches: {sellToken: string; buyToken: string; baselineBuy: string; floor: string | null}[];
}

export async function buildReceipt(batchId: bigint, facts: BatchFacts, ctx: ReceiptContext): Promise<BuiltReceipt | null> {
  const b = facts.batch;
  if (!b) return null;
  const solution = facts.winning ? ((typeof facts.winning.solution === "string" ? JSON.parse(facts.winning.solution) : facts.winning.solution) as SolutionJson) : null;
  const outcome = publicOutcome(String(b.outcome), (b.reason as string | null) ?? null);

  const stored = new Map(facts.quotes.map((r) => [quoteKey(String(r.sell_token), String(r.buy_token), big(r.amount), big(r.quote_block), String(r.adapter)), r.amount_out === null ? null : big(r.amount_out)]));
  const quote = async (sell: Address, buy: Address, amount: bigint, block: bigint): Promise<Quoted> => {
    const key = quoteKey(sell, buy, amount, block, ctx.baselineAdapter);
    if (stored.has(key)) return stored.get(key) ?? "reverts";
    try {
      return (await ctx.quote(sell, buy, amount, block)) ?? "reverts";
    } catch (error) {
      ctx.log?.(`quoteFromState ${sell} to ${buy} on ${amount} at ${block} unavailable, ${(error as Error).message.split("\n")[0]}`);
      return "unavailable";
    }
  };

  const quoteAbi = loadAbi("UniswapV3Adapter");
  const attributed = attribute(
    facts.fills.map((f) => ({sellToken: String(f.sell_token), buyToken: String(f.buy_token), executedSell: big(f.executed_sell)})),
    facts.venueRoutes.map((r) => ({tokenIn: String(r.token_in), tokenOut: String(r.token_out), amountIn: big(r.amount_in)})),
  );

  const mismatches: BuiltReceipt["baselineMismatches"] = [];
  const fills: FillReceipt[] = [];
  for (const [n, f] of facts.fills.entries()) {
    const executedSell = big(f.executed_sell);
    const executedBuy = big(f.executed_buy);
    const baselineBuy = big(f.baseline_buy);
    const execution = solution?.executions.find((e) => {
      const i = solution.intents[Number(e.intentIndex)];
      return i && same(i.owner, f.owner) && same(e.executedSell, executedSell) && same(e.executedBuy, executedBuy);
    });
    const intent = execution ? solution!.intents[Number(execution.intentIndex)]! : null;

    const sellToken = String(f.sell_token) as Address;
    const buyToken = String(f.buy_token) as Address;
    const block = quoteBlock(facts, f);
    const expected = await quote(sellToken, buyToken, executedSell, block);
    const sellMeta = ctx.tokens.get(sellToken.toLowerCase());
    fills.push({
      intentHash: String(f.intent_hash) as Hex,
      owner: String(f.owner) as Address,
      receiver: (intent?.receiver ?? String(f.owner)) as Address,
      sellToken: tokenRef(sellToken, ctx),
      buyToken: tokenRef(buyToken, ctx),
      executedSell: String(executedSell),
      executedBuy: String(executedBuy),
      baselineBuy: String(baselineBuy),
      savingsUsd: String(f.savings_usd),
      improvementBps: improvementBps(executedBuy, baselineBuy),
      attribution: {nettedSell: String(attributed[n]!.nettedSell), routedSell: String(attributed[n]!.routedSell)},
      partial: intent ? executedSell < big(intent.sellAmount) : false,
      verifyBaseline: {
        to: ctx.baselineAdapter,
        data: encodeFunctionData({abi: quoteAbi, functionName: "quoteFromState", args: [sellToken, buyToken, executedSell]}),
        blockNumber: String(block),
        castCommand: `cast call ${ctx.baselineAdapter} "quoteFromState(address,address,uint256)(uint256)" ${sellToken} ${buyToken} ${executedSell} --block ${block} --rpc-url ${ctx.rpcUrl}`,
        expected: shown(expected),
        describes: `UniswapV3Adapter.quoteFromState, ${sellMeta?.symbol ?? sellToken} to ${ctx.tokens.get(buyToken.toLowerCase())?.symbol ?? buyToken} at the block the verifier read`,
      },
      provenance: provenanceOf(f, ctx.source),
    });
  }

  const baselineFloors: BaselineFloor[] = [];
  for (const d of directions(facts)) {
    const floor = await quote(d.sell, d.buy, d.executedSell, d.block);
    const holds = typeof floor === "bigint" ? d.baselineBuy >= floor : null;
    // A state the node dropped says nothing about the batch, so it is no mismatch.
    if (holds === false || floor === "reverts") {
      mismatches.push({sellToken: d.sell, buyToken: d.buy, baselineBuy: String(d.baselineBuy), floor: typeof floor === "bigint" ? String(floor) : null});
      ctx.log?.(`baseline floor in batch ${batchId}, ${d.sell} to ${d.buy}: sum ${d.baselineBuy}, quoteFromState on ${d.executedSell} at ${d.block} ${shown(floor)}`);
    }
    baselineFloors.push({
      sellToken: tokenRef(d.sell, ctx),
      buyToken: tokenRef(d.buy, ctx),
      fills: d.fills,
      executedSell: String(d.executedSell),
      baselineBuy: String(d.baselineBuy),
      verifyFloor: {
        to: ctx.baselineAdapter,
        data: encodeFunctionData({abi: quoteAbi, functionName: "quoteFromState", args: [d.sell, d.buy, d.executedSell]}),
        blockNumber: String(d.block),
        castCommand: `cast call ${ctx.baselineAdapter} "quoteFromState(address,address,uint256)(uint256)" ${d.sell} ${d.buy} ${d.executedSell} --block ${d.block} --rpc-url ${ctx.rpcUrl}`,
        expected: shown(floor),
        describes: `UniswapV3Adapter.quoteFromState on the direction's whole volume, ${ctx.tokens.get(d.sell.toLowerCase())?.symbol ?? d.sell} to ${ctx.tokens.get(d.buy.toLowerCase())?.symbol ?? d.buy}, at the block the verifier read`,
      },
      holds,
    });
  }

  const clearingPrices: ClearingPriceRow[] = facts.prices.map((p) => {
    const price = big(p.price);
    const ref = big(p.ref_price);
    const diff = price > ref ? price - ref : ref - price;
    return {
      token: tokenRef(String(p.token), ctx),
      price: String(price),
      refPrice: String(ref),
      deviationBps: String(p.deviation_bps),
      withinBand: diff * 10_000n <= BigInt(ctx.maxDeviationBps) * ref,
    };
  });

  const venueRoutes: VenueRoute[] = facts.venueRoutes.map((r) => {
    const call = solution?.venueCalls.find((v) => same(v.adapter, r.adapter) && same(v.tokenIn, r.token_in) && same(v.tokenOut, r.token_out) && same(v.amountIn, r.amount_in));
    const stock = same(r.token_in, ctx.quoteToken) ? String(r.token_out) : String(r.token_in);
    const pool = ctx.tokens.get(stock.toLowerCase())?.pool ?? "";
    return {
      adapter: String(r.adapter) as Address,
      pool: pool as Address,
      tokenIn: tokenRef(String(r.token_in), ctx),
      tokenOut: tokenRef(String(r.token_out), ctx),
      amountIn: String(r.amount_in),
      minOut: call ? String(call.minOut) : "",
      amountOut: String(r.amount_out),
      explorerUrl: `${ctx.explorer}/address/${pool || r.adapter}`,
    };
  });

  // A solution that arrives first and is then beaten is replaced in place,
  // with no SolutionRejected, so its row still reads accepted. Once the batch
  // has a winner, only the winning hash is accepted and a loser without a
  // rejection event is named as replaced. N16.
  const winningHash = facts.winning ? String(facts.winning.solution_hash).toLowerCase() : null;
  const solutions: SolutionSummary[] = facts.solutions.map((s) => {
    const rejected = (s.rejection_reason as string | null) ?? null;
    const won = winningHash === null ? Boolean(s.accepted) : String(s.solution_hash).toLowerCase() === winningHash;
    return {
      solver: String(s.solver) as Address,
      solutionHash: String(s.solution_hash) as Hex,
      claimedSavingsUsd: String(s.claimed_savings),
      accepted: won,
      rejectionReason: won ? null : (rejected ?? "replaced by a better solution"),
      submittedAt: Number(s.block_timestamp),
      provenance: provenanceOf(s, ctx.source),
    };
  });

  const netted = b.netted_usd === null || b.netted_usd === undefined ? 0n : big(b.netted_usd);
  const routed = b.routed_usd === null || b.routed_usd === undefined ? 0n : big(b.routed_usd);
  const owners = new Set(facts.fills.length ? facts.fills.map((f) => String(f.owner)) : (solution?.intents ?? []).map((i) => i.owner.toLowerCase()));
  const reason = (b.reason as string | null) ?? null;

  const receipt: BatchReceipt = {
    batchId: String(batchId),
    outcome,
    session: ctx.session,
    sessionName: ctx.sessionName,
    batchDurationSeconds: ctx.batchDurationSeconds,
    intentCount: Number(b.intent_count),
    participantCount: owners.size,
    solver: (b.solver as Address | null) ?? (facts.solutions.filter((s) => s.accepted).at(-1)?.solver as Address | undefined) ?? null,
    solutions,
    fills,
    baselineFloors,
    clearingPrices,
    venueRoutes,
    totals: {
      notionalUsd: String(netted + routed),
      nettedVolumeUsd: String(netted),
      routedVolumeUsd: String(routed),
      nettingRatioBps: nettingRatioBps(netted, routed),
      totalSavingsUsd: String(b.savings_usd ?? "0"),
      solverFeeUsd: String(b.solver_fee_usd ?? "0"),
      protocolFeeUsd: String(b.protocol_fee_usd ?? "0"),
    },
    // Replaces the 26 September shape, settled with a SavingsBelowThreshold
    // failure, after the frontend audit of 1 October read it as nothing settled.
    failure:
      outcome === "settled" || outcome === "settled_at_venue"
        ? null
        : {
            code: FAILURE_CODES[reason ?? ""] ?? "BatchPassthrough",
            reason: [reason ?? "", ...facts.collectionFailures.map((c) => `owner ${c.owner} could not be collected at intent ${c.intent_index}`)].filter(Boolean).join(". "),
            // The chain holds no single buy figure for a batch that executed
            // nothing, and a sum across tokens would mean nothing.
            bestSolutionBuy: null,
            baselineBuy: null,
            shortfall: null,
            feeCharged: "0",
          },
    provenance: provenanceOf(b, ctx.source),
  };
  return {receipt, baselineMismatches: mismatches};
}
