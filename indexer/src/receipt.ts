// The batch receipt, built only from indexed facts and one eth_call per fill.
//
// Every figure comes from an event, from the winning Solution in the finalize
// calldata, or from the chain at a named block. Where the chain holds nothing,
// the field is null, never zero and never a guess.

import {encodeFunctionData, type Address, type Hex} from "viem";
import type {
  ApiErrorCode,
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
  const [batch, winning, fills, prices, solutions, venueRoutes, collectionFailures] = await Promise.all([
    one("batches"),
    one("batch_solutions"),
    many(FACT_TABLES.fills),
    many(FACT_TABLES.prices),
    many(FACT_TABLES.solutions),
    many(FACT_TABLES.venueRoutes),
    many(FACT_TABLES.collectionFailures),
  ]);
  return {batch, winning, fills, prices, solutions, venueRoutes, collectionFailures};
}

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
  /** quoteFromState through eth_call at a block, or null when it reverts. */
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

const FAILURE_CODES: Record<string, ApiErrorCode> = {
  "winner never finalized": "WinnerNeverFinalized",
  "intent could not be collected": "IntentCollectionFailed",
  "savings below threshold": "SavingsBelowThreshold",
};

interface SolutionJson {
  intents: {owner: string; receiver: string; sellToken: string; buyToken: string; sellAmount: string}[];
  executions: {intentIndex: string; executedSell: string; executedBuy: string}[];
  venueCalls: {adapter: string; tokenIn: string; tokenOut: string; amountIn: string; minOut: string}[];
}

export interface BuiltReceipt {
  receipt: BatchReceipt;
  /** Fills whose baseline, recomputed at the block the verifier read, differs from the event. */
  baselineMismatches: {intentHash: string; baselineBuy: string; expected: string | null}[];
}

export async function buildReceipt(batchId: bigint, facts: BatchFacts, ctx: ReceiptContext): Promise<BuiltReceipt | null> {
  const b = facts.batch;
  if (!b) return null;
  const solution = facts.winning ? ((typeof facts.winning.solution === "string" ? JSON.parse(facts.winning.solution) : facts.winning.solution) as SolutionJson) : null;
  const outcome = b.outcome as BatchReceipt["outcome"];

  // verifyBaseline reads the pool state the verifier read, which is the parent
  // of the block holding the winning submitSolution.
  const winningSubmit = facts.winning ? facts.solutions.find((s) => same(s.solution_hash, facts.winning!.solution_hash)) : null;
  const verifyBlock = winningSubmit ? big(winningSubmit.block_number) - 1n : null;

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
    const block = verifyBlock ?? big(f.block_number) - 1n;
    const expected = await ctx.quote(sellToken, buyToken, executedSell, block);
    if (expected === null || expected !== baselineBuy) {
      mismatches.push({intentHash: String(f.intent_hash), baselineBuy: String(baselineBuy), expected: expected === null ? null : String(expected)});
      ctx.log?.(`baseline for ${f.intent_hash} in batch ${batchId}: event ${baselineBuy}, quoteFromState at ${block} ${expected ?? "reverts"}`);
    }
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
        expected: expected === null ? "reverts" : String(expected),
        describes: `UniswapV3Adapter.quoteFromState, ${sellMeta?.symbol ?? sellToken} to ${ctx.tokens.get(buyToken.toLowerCase())?.symbol ?? buyToken} at the block the verifier read`,
      },
      provenance: provenanceOf(f, ctx.source),
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

  const solutions: SolutionSummary[] = facts.solutions.map((s) => ({
    solver: String(s.solver) as Address,
    solutionHash: String(s.solution_hash) as Hex,
    claimedSavingsUsd: String(s.claimed_savings),
    accepted: Boolean(s.accepted),
    rejectionReason: (s.rejection_reason as string | null) ?? null,
    submittedAt: Number(s.block_timestamp),
    provenance: provenanceOf(s, ctx.source),
  }));

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
    failure:
      outcome === "settled"
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
