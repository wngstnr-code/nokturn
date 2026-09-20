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
import type {ConfigResponse, TokenInfo} from "../../../packages/shared/api-types.ts";
import {
  INTENT_TYPE_STRING,
  chain,
  permit2Abi,
  read,
  settlementAbi,
  explorerAddress,
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

  app.get("/v1/health", async () => {
    const c = chain();
    let rpcUp = true;
    let blockNumber = 0n;
    try {
      blockNumber = await c.client.getBlockNumber();
    } catch {
      rpcUp = false;
    }
    return {
      ok: rpcUp,
      apiVersion: "v1" as const,
      chainId: c.chainId,
      // No indexer yet, so the lag is not a number this API can honestly report.
      indexerLagBlocks: "0",
      components: {
        rpc: rpcUp ? ("up" as const) : ("down" as const),
        indexer: "down" as const,
        database: "down" as const,
        scheduler: "down" as const,
      },
      blockNumber: String(blockNumber),
      explorer: explorerAddress(c.deployment.settlement),
    };
  });
}
