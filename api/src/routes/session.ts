// GET /v1/session and GET /v1/batches/current
//
// Both read SessionManager and neither recomputes anything. The calendar lives
// on chain and the UI reads it, because two implementations of a calendar give
// two answers in front of a judge. docs/pembagian-tugas.md section 4.
//
// The batch window comes from packages/shared/batch.ts rather than from a local
// calculation, for the same reason. That helper is the only sanctioned way to
// derive a batchId and it is held to the contract by make check-batch.

import type {FastifyInstance} from "fastify";
import type {CurrentBatchResponse, SessionName, SessionResponse} from "../../../packages/shared/api-types.ts";
import {isBatch} from "../../../packages/shared/batch.ts";
import {chain, read, sessionAbi} from "../chain.ts";
import {counts, openWindow} from "../mempool.ts";
import {provenance, stamp} from "../provenance.ts";

/** Index by the Session enum, contracts/src/types/Types.sol. */
export const SESSION_NAMES: SessionName[] = [
  "CLOSED_OVERNIGHT",
  "PRE_MARKET",
  "AUCTION_OPEN",
  "OPEN",
  "AUCTION_CLOSE",
  "POST_MARKET",
  "CLOSED_WEEKEND",
  "HOLIDAY",
  "PROTECTIVE",
];

/** PriceOracle._isFrozenSession, mirrored because the API has to explain it. */
const FROZEN_SESSIONS = new Set([6, 7]);

/** PriceOracle constants, parameter.md section 7. */
const ORACLE_DISAGREE_BPS = 50;
const ORACLE_DISAGREE_BPS_OVERNIGHT = 150;
const WEEKEND_DRIFT_CAP_BPS = 1500;

function priceSource(session: number): SessionResponse["priceSource"] {
  // On a frozen session the Chainlink feed has stopped moving, so the TWAP leads
  // and the feed becomes the Friday anchor. The disagreement check is switched
  // off because it would only measure how long the weekend has been, and the
  // drift cap guards the session instead. PriceOracle.refPrice and dualCheck.
  if (FROZEN_SESSIONS.has(session)) {
    return {
      primary: "uniswapV3Twap",
      anchor: "chainlink",
      disagreementCheckEnabled: false,
      weekendDriftCapBps: WEEKEND_DRIFT_CAP_BPS,
    };
  }
  return {
    primary: "chainlink",
    anchor: "uniswapV3Twap",
    disagreementCheckEnabled: true,
    weekendDriftCapBps: null,
  };
}

export function disagreementLimitBps(session: number): number | null {
  if (FROZEN_SESSIONS.has(session)) return null;
  return session === 0 ? ORACLE_DISAGREE_BPS_OVERNIGHT : ORACLE_DISAGREE_BPS;
}

export function sessionRoutes(app: FastifyInstance) {
  app.get("/v1/session", async (): Promise<SessionResponse> => {
    const c = chain();
    const at = await stamp();

    const session = await read<number>(c.deployment.sessions, sessionAbi, "currentSession");
    const [batchDuration, maxDeviationBps, inGuardBand, nextTransition] = await Promise.all([
      read<number>(c.deployment.sessions, sessionAbi, "batchDuration", [session]),
      read<number>(c.deployment.sessions, sessionAbi, "maxDeviationBps", [session]),
      read<boolean>(c.deployment.sessions, sessionAbi, "inGuardBand", [at.timestamp]),
      read<bigint>(c.deployment.sessions, sessionAbi, "nextTransition", [at.timestamp]),
    ]);

    // PROTECTIVE is per token rather than per chain, so it is asked per token.
    const protective = await Promise.all(
      c.tokens.map(async (t) => ({
        token: t.token,
        symbol: t.symbol,
        session: await read<number>(c.deployment.sessions, sessionAbi, "tokenSession", [t.token]),
      })),
    );

    return {
      session,
      sessionName: SESSION_NAMES[session]!,
      chainTime: Number(at.timestamp),
      batchDurationSeconds: Number(batchDuration),
      maxDeviationBps: Number(maxDeviationBps),
      inGuardBand,
      nextTransition: Number(nextTransition),
      priceSource: priceSource(session),
      protectiveTokens: protective
        .filter((p) => p.session === 8)
        .map((p) => ({token: p.token, symbol: p.symbol, reason: "token is in PROTECTIVE"})),
      provenance: provenance(at),
    };
  });

  app.get("/v1/batches/current", async (): Promise<CurrentBatchResponse> => {
    const c = chain();
    const at = await stamp();

    const session = await read<number>(c.deployment.sessions, sessionAbi, "currentSession");
    const lookup = await openWindow(at);

    if (!isBatch(lookup)) {
      return {
        batchId: null,
        reason: lookup.reason === "auction_phase" ? "auction_phase" : "guard_band",
        session,
        sessionName: SESSION_NAMES[session]!,
        collectStartsAt: 0,
        collectEndsAt: 0,
        solveEndsAt: 0,
        chainTime: Number(at.timestamp),
        intentCount: 0,
        participantCount: 0,
        provenance: provenance(at),
      };
    }

    const {intentCount, participantCount} = counts(lookup.batchId);
    return {
      batchId: String(lookup.batchId),
      session: lookup.session,
      sessionName: SESSION_NAMES[lookup.session]!,
      collectStartsAt: Number(lookup.collectStart),
      collectEndsAt: Number(lookup.collectEnd),
      solveEndsAt: Number(lookup.solveEnd),
      chainTime: Number(at.timestamp),
      intentCount,
      participantCount,
      provenance: provenance(at),
    };
  });
}
