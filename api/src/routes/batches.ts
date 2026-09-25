// GET /v1/batches and GET /v1/batches/:batchId, served from the indexer's tables.
//
// The queries and the receipt live in indexer/src and are imported, not copied.
// The database connection is created on the first request, so the API starts and
// serves every other route with the database down, and these two answer 503.

import type {FastifyInstance, FastifyReply} from "fastify";
import type {Address} from "viem";
import type {ApiError, BatchListResponse, BatchReceipt, BatchSummary, FillReceipt} from "../../../packages/shared/api-types.ts";
import {isValidBatchId} from "../../../packages/shared/batch.ts";
import {createChainReader} from "../../../packages/shared/batch-viem.ts";
import {db} from "../../../indexer/src/db.ts";
import {buildReceipt, loadFacts, nettingRatioBps, type ReceiptContext, type TokenMeta} from "../../../indexer/src/receipt.ts";
import {adapterAbi, chain, read, revertReason, sessionAbi, settlementAbi} from "../chain.ts";
import {env} from "../config.ts";
import {badRequest, notFound} from "../errors.ts";
import {counts} from "../mempool.ts";
import {provenance, source, stamp} from "../provenance.ts";
import {SESSION_NAMES} from "./session.ts";

const PAGE = 50;
/** Settlement.SOLUTION_WINDOW and FINALIZE_DEADLINE, parameter.md section 6. */
const SOLUTION_WINDOW = 10n;
const FINALIZE_DEADLINE = 300n;

export class IndexerDown extends Error {}

/** Anything the database throws is the database being unreachable, as far as a caller can act on it. */
async function query<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new IndexerDown((error as Error).message.split("\n")[0]);
  }
}

function indexerDown(reply: FastifyReply, error: IndexerDown) {
  const body: ApiError = {
    code: "COORDINATOR_UPSTREAM_DOWN",
    message: `the indexer database is not answering. ${error.message}`,
    detail: {needs: "the indexer database"},
  };
  return reply.code(503).send(body);
}

function parseBatchId(raw: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || BigInt(raw) >= 1n << 64n) {
    throw badRequest("COORDINATOR_INVALID_REQUEST", "batchId is a decimal uint64", {batchId: raw});
  }
  return BigInt(raw);
}

async function receiptContext(batchId: bigint): Promise<ReceiptContext> {
  const c = chain();
  const session = await read<number>(c.deployment.sessions, sessionAbi, "sessionAt", [batchId]);
  const [duration, maxDeviationBps, baselineAdapter] = await Promise.all([
    read<number>(c.deployment.sessions, sessionAbi, "batchDuration", [session]),
    read<number>(c.deployment.sessions, sessionAbi, "maxDeviationBps", [session]),
    read<Address>(c.deployment.settlement, settlementAbi, "baselineAdapter"),
  ]);
  const tokens = new Map<string, TokenMeta>(c.tokens.map((t) => [t.token.toLowerCase(), {symbol: t.symbol, decimals: t.decimals, pool: t.pool}]));
  tokens.set(c.quote.address.toLowerCase(), {symbol: "USDG", decimals: c.quote.decimals});
  return {
    chainId: c.chainId,
    source: source(),
    tokens,
    quoteToken: c.quote.address,
    explorer: c.explorer,
    rpcUrl: env.rpc,
    baselineAdapter,
    session,
    sessionName: SESSION_NAMES[session]!,
    batchDurationSeconds: Number(duration),
    maxDeviationBps: Number(maxDeviationBps),
    quote: async (sellToken, buyToken, amount, blockNumber) => {
      try {
        return await read<bigint>(baselineAdapter, adapterAbi, "quoteFromState", [sellToken, buyToken, amount], blockNumber);
      } catch (error) {
        if (revertReason(error) === null) throw error;
        return null;
      }
    },
  };
}

export async function receiptFor(batchId: bigint) {
  const c = chain();
  const facts = await query(() => loadFacts(db({readOnly: true}), c.deployment.settlement, batchId));
  if (!facts.batch) return null;
  return buildReceipt(batchId, facts, await receiptContext(batchId));
}

/** A batch still collecting or waiting on its finalize is real, and it is answered as it is. */
async function running(batchId: bigint): Promise<BatchReceipt | null> {
  const c = chain();
  const at = await stamp();
  let valid: boolean;
  try {
    valid = await isValidBatchId(createChainReader(c.client, c.deployment.sessions), batchId);
  } catch (error) {
    if (revertReason(error) === null) throw error;
    valid = false;
  }
  if (!valid) return null;
  const solveEnd = batchId + SOLUTION_WINDOW;
  if (at.timestamp > solveEnd + FINALIZE_DEADLINE) return null;
  const outcome = at.timestamp <= batchId ? "collecting" : "solving";
  const ctx = await receiptContext(batchId);
  const {intentCount, participantCount} = counts(batchId);
  return {
    batchId: String(batchId),
    outcome,
    session: ctx.session,
    sessionName: ctx.sessionName,
    batchDurationSeconds: ctx.batchDurationSeconds,
    intentCount,
    participantCount,
    solver: null,
    solutions: [],
    fills: [],
    clearingPrices: [],
    venueRoutes: [],
    totals: {notionalUsd: "0", nettedVolumeUsd: "0", routedVolumeUsd: "0", nettingRatioBps: "0", totalSavingsUsd: "0", solverFeeUsd: "0", protocolFeeUsd: "0"},
    failure: null,
    provenance: provenance(at),
  };
}

/** The fill for one intent, or null when it has none or the database cannot say. */
export async function fillFor(intentHash: string): Promise<FillReceipt | null> {
  const c = chain();
  try {
    const res = await db({readOnly: true}).query("SELECT batch_id FROM fills WHERE deployment = $1 AND intent_hash = $2 LIMIT 1", [c.deployment.settlement.toLowerCase(), intentHash.toLowerCase()]);
    if (!res.rows[0]) return null;
    const built = await receiptFor(BigInt(res.rows[0].batch_id));
    return built?.receipt.fills.find((f) => f.intentHash.toLowerCase() === intentHash.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

export function batchRoutes(app: FastifyInstance) {
  app.get<{Querystring: {cursor?: string}}>("/v1/batches", async (request, reply): Promise<BatchListResponse | unknown> => {
    const cursor = request.query.cursor === undefined ? null : parseBatchId(request.query.cursor);
    const c = chain();
    try {
      const rows = await query(async () =>
        (
          await db({readOnly: true}).query(
            `SELECT b.batch_id, b.outcome, b.session, b.intent_count, b.netted_usd, b.routed_usd, b.savings_usd, b.block_timestamp,
                    (SELECT count(DISTINCT f.owner)::int FROM fills f WHERE f.deployment = b.deployment AND f.batch_id = b.batch_id) AS participants
               FROM batches b
              WHERE b.deployment = $1 AND ($2::numeric IS NULL OR b.batch_id < $2::numeric)
              ORDER BY b.batch_id DESC
              LIMIT $3`,
            [c.deployment.settlement.toLowerCase(), cursor === null ? null : String(cursor), PAGE + 1],
          )
        ).rows,
      );
      const page = rows.slice(0, PAGE);
      // BatchPassthrough carries no session, so a failed batch's is read from the
      // calendar at its own timestamp, the same answer Settlement would get.
      const sessions = await Promise.all(page.map((r) => (r.session === null ? read<number>(c.deployment.sessions, sessionAbi, "sessionAt", [BigInt(r.batch_id)]) : Promise.resolve(Number(r.session)))));
      const batches: BatchSummary[] = page.map((r, n) => ({
        batchId: String(r.batch_id),
        outcome: r.outcome,
        sessionName: SESSION_NAMES[sessions[n]!]!,
        intentCount: Number(r.intent_count),
        participantCount: Number(r.participants),
        nettingRatioBps: nettingRatioBps(BigInt(r.netted_usd ?? 0), BigInt(r.routed_usd ?? 0)),
        totalSavingsUsd: String(r.savings_usd ?? "0"),
        settledAt: r.outcome === "settled" ? Number(r.block_timestamp) : null,
      }));
      return {batches, cursor: rows.length > PAGE ? batches.at(-1)!.batchId : null};
    } catch (error) {
      if (error instanceof IndexerDown) return indexerDown(reply, error);
      throw error;
    }
  });

  app.get<{Params: {batchId: string}}>("/v1/batches/:batchId", async (request, reply): Promise<BatchReceipt | unknown> => {
    const batchId = parseBatchId(request.params.batchId);
    try {
      const built = await receiptFor(batchId);
      if (built) {
        if (built.baselineMismatches.length) request.log.warn({batchId: String(batchId), mismatches: built.baselineMismatches}, "recomputed baseline differs from the event");
        return built.receipt;
      }
    } catch (error) {
      if (error instanceof IndexerDown) return indexerDown(reply, error);
      throw error;
    }
    const live = await running(batchId);
    if (live) return live;
    throw notFound("COORDINATOR_INVALID_REQUEST", `no batch ${batchId} is indexed, collecting or waiting on its finalize`);
  });
}
