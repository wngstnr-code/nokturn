// GET /v1/config
//
// Everything the frontend would otherwise hardcode, read from the chain at
// request time.
//
// The three EIP-712 values are the reason this route exists. Permit2 rebuilds
// its domain separator whenever the chain id is not the one it was deployed on,
// and the Settlement address differs on the fork, on 46630 and on mainnet. A
// copied constant is right on exactly one of the three and silently wrong on the
// other two, and the symptom is a signature that will not verify with nothing
// saying why.

import type {FastifyInstance} from "fastify";
import {keccak256, toHex} from "viem";
import type {ConfigResponse, HealthResponse, TokenInfo} from "../../../packages/shared/api-types.ts";
import {db} from "../../../indexer/src/db.ts";
import {lastLifecycleTick} from "../lifecycle.ts";
import {
  INTENT_TYPE_STRING,
  chain,
  permit2Abi,
  read,
  settlementAbi,
  explorerAddress,
  rpcStatus,
} from "../chain.ts";
import {source} from "../provenance.ts";

export function configRoutes(app: FastifyInstance) {
  app.get("/v1/config", async (): Promise<ConfigResponse> => {
    const c = chain();
    const d = c.deployment;

    const [witnessTypeString, permit2DomainSeparator, solutionWindow, finalizeDeadline] = await Promise.all([
      read<string>(d.settlement, settlementAbi, "WITNESS_TYPE_STRING"),
      read<`0x${string}`>(c.permit2, permit2Abi, "DOMAIN_SEPARATOR"),
      read<number>(d.settlement, settlementAbi, "SOLUTION_WINDOW"),
      read<number>(d.settlement, settlementAbi, "FINALIZE_DEADLINE"),
    ]);

    const [capPerBatchUsd, capPerTokenDailyUsd, capGlobalDailyUsd] = await Promise.all([
      read<bigint>(d.settlement, settlementAbi, "capPerBatchUsd"),
      read<bigint>(d.settlement, settlementAbi, "capPerTokenDailyUsd"),
      read<bigint>(d.settlement, settlementAbi, "capGlobalDailyUsd"),
    ]);

    const tokens: TokenInfo[] = await Promise.all(
      c.tokens.map(async (t) => ({
        symbol: t.symbol,
        address: t.token,
        decimals: t.decimals,
        pool: t.pool,
        feed: t.feed,
        allowed: await read<boolean>(d.settlement, settlementAbi, "tokenAllowed", [t.token]),
      })),
    );

    return {
      apiVersion: "v1",
      chainId: c.chainId,
      source: source(),
      contracts: {
        settlement: d.settlement,
        sessions: d.sessions,
        oracle: d.oracle,
        solvers: d.solvers,
        auctionHouse: d.auctionHouse,
        mandates: d.mandates,
        adapter: d.adapter,
        verifier: d.verifier,
        permit2: c.permit2,
        timelock: d.timelock,
      },
      quoteToken: {
        symbol: "USDG",
        address: c.quote.address,
        decimals: c.quote.decimals,
        allowed: await read<boolean>(d.settlement, settlementAbi, "tokenAllowed", [c.quote.address]),
      },
      tokens,
      eip712: {
        witnessTypeString,
        // Hashed here rather than read, because IntentLib is a library and the
        // typehash is not exposed on any deployed surface. The string it hashes
        // is the same one WITNESS_TYPE_STRING above carries, so a divergence
        // shows up as a mismatch between these two fields.
        intentTypehash: keccak256(toHex(INTENT_TYPE_STRING)),
        permit2DomainSeparator,
        spender: d.settlement,
      },
      limits: {
        capPerBatchUsd: String(capPerBatchUsd),
        capPerTokenDailyUsd: String(capPerTokenDailyUsd),
        capGlobalDailyUsd: String(capGlobalDailyUsd),
        solutionWindow: Number(solutionWindow),
        finalizeDeadline: Number(finalizeDeadline),
      },
    };
  });

  app.get("/v1/health", async (): Promise<HealthResponse & {blockNumber: string; explorer: string}> => {
    const c = chain();
    let rpcUp = true;
    let blockNumber = 0n;
    let headTime = 0n;
    try {
      const head = await c.client.getBlock();
      blockNumber = head.number;
      headTime = head.timestamp;
    } catch {
      rpcUp = false;
    }

    let databaseUp = true;
    let indexedTo: bigint | null = null;
    try {
      indexedTo = await withTimeout(indexerCheckpoint(c.chainId, c.deployment.settlement), DATABASE_TIMEOUT_MS);
    } catch {
      databaseUp = false;
    }

    // With no checkpoint or no database the lag cannot be measured, so it reads
    // zero and the indexer component says down rather than implying it is current.
    const lag = rpcUp && indexedTo !== null && blockNumber > indexedTo ? blockNumber - indexedTo : 0n;
    let lagSeconds = 0n;
    if (lag > 0n) {
      const indexedAt = await c.client.getBlock({blockNumber: indexedTo!}).then((b) => b.timestamp, () => null);
      lagSeconds = indexedAt === null ? INDEXER_DEGRADED_LAG_SECONDS + 1n : headTime - indexedAt;
    }
    const indexer = !databaseUp || indexedTo === null ? "down" : lagSeconds <= INDEXER_UP_LAG_SECONDS ? "up" : lagSeconds <= INDEXER_DEGRADED_LAG_SECONDS ? "degraded" : "down";

    const rpc = rpcStatus();
    const tick = lastLifecycleTick();
    const since = tick === null ? Infinity : Date.now() - tick;
    const scheduler = since <= SCHEDULER_UP_MS ? "up" : since <= SCHEDULER_DEGRADED_MS ? "degraded" : "down";

    return {
      ok: rpcUp,
      apiVersion: "v1",
      chainId: c.chainId,
      indexerLagBlocks: String(lag),
      // Degraded while a fallback endpoint answers or the minute's budget is spent. F6.
      components: {rpc: !rpcUp ? "down" : rpc.primary && !rpc.overBudget ? "up" : "degraded", indexer, database: databaseUp ? "up" : "down", scheduler},
      blockNumber: String(blockNumber),
      explorer: explorerAddress(c.deployment.settlement),
    };
  });
}

/**
 * In chain seconds, not blocks. A few seconds behind is normal and a minute
 * behind means it has stalled, N18. Counted in blocks this assumed the fork's
 * one a second, and mainnet seals about ten, so twenty confirmations alone read
 * as degraded there. Measured 1 October 2026.
 */
const INDEXER_UP_LAG_SECONDS = 10n;
const INDEXER_DEGRADED_LAG_SECONDS = 60n;
/** The lifecycle polls every 500 ms. Ten seconds without a tick is a stall. */
const SCHEDULER_UP_MS = 10_000;
const SCHEDULER_DEGRADED_MS = 60_000;
/** Health must answer while the database is down, I4, so the check gives up fast. */
const DATABASE_TIMEOUT_MS = 2_000;

async function indexerCheckpoint(chainId: number, settlement: string): Promise<bigint | null> {
  const r = await db().query("SELECT last_block FROM indexer_state WHERE chain_id = $1 AND settlement = $2", [chainId, settlement.toLowerCase()]);
  return r.rows.length ? BigInt(r.rows[0].last_block) : null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}
