import type {Address} from "viem";
import {clientFor} from "./chain";
import {deploymentFor} from "./deployments";
import {priceOracleAbi, sessionManagerAbi} from "./abi";
import {Session} from "@shared/types";

export const SESSION_NAMES: Record<Session, string> = {
  [Session.CLOSED_OVERNIGHT]: "Closed overnight",
  [Session.PRE_MARKET]: "Pre market",
  [Session.AUCTION_OPEN]: "Opening auction",
  [Session.OPEN]: "Open",
  [Session.AUCTION_CLOSE]: "Closing auction",
  [Session.POST_MARKET]: "Post market",
  [Session.CLOSED_WEEKEND]: "Closed weekend",
  [Session.HOLIDAY]: "Holiday",
  [Session.PROTECTIVE]: "Protective",
};

export type TokenOracle = {
  symbol: string;
  address: Address;
  refPrice: bigint | null;
  refUpdatedAt: bigint | null;
  refHealthy: boolean | null;
  refError: string | null;
  chainlink: bigint | null;
  uniTwap: bigint | null;
  agree: boolean | null;
  dualError: string | null;
  stalenessLimit: number | null;
  tokenSession: Session | null;
};

export type SessionReport = {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  sessionManager: Address;
  oracle: Address;
  session: Session;
  batchDuration: number;
  maxDeviationBps: number;
  nextTransition: bigint;
  inGuardBand: boolean;
  easternDay: number;
  tokens: TokenOracle[];
};

export type Reading<T> = {value: T; error: null} | {value: null; error: string};

/// A revert is an answer. FeedNotSet on a testnet token is the truth about that
/// token, so the name is carried to the screen rather than flattened to null.
async function reading<T>(work: Promise<T>): Promise<Reading<T>> {
  try {
    return {value: await work, error: null};
  } catch (thrown) {
    return {value: null, error: revertName(thrown)};
  }
}

function revertName(thrown: unknown): string {
  const seen = new Set<unknown>();
  let cursor: unknown = thrown;
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const node = cursor as {data?: {errorName?: string}; cause?: unknown; shortMessage?: string};
    if (typeof node.data?.errorName === "string") return node.data.errorName;
    cursor = node.cause;
  }
  const short = (thrown as {shortMessage?: string}).shortMessage;
  return short ?? (thrown instanceof Error ? thrown.message.slice(0, 120) : "unreadable");
}

async function readOracle(
  chainId: number,
  oracle: Address,
  sessions: Address,
  entry: {symbol: string; address: Address},
  blockNumber: bigint,
): Promise<TokenOracle> {
  const client = clientFor(chainId);
  const at = {blockNumber} as const;

  const [ref, dual, staleness, tokenSession] = await Promise.all([
    reading(
      client.readContract({
        address: oracle,
        abi: priceOracleAbi,
        functionName: "refPrice",
        args: [entry.address],
        ...at,
      }) as Promise<readonly [bigint, bigint, boolean]>,
    ),
    reading(
      client.readContract({
        address: oracle,
        abi: priceOracleAbi,
        functionName: "dualCheck",
        args: [entry.address],
        ...at,
      }) as Promise<readonly [bigint, bigint, boolean]>,
    ),
    reading(
      client.readContract({
        address: oracle,
        abi: priceOracleAbi,
        functionName: "stalenessLimit",
        args: [entry.address],
        ...at,
      }) as Promise<number>,
    ),
    reading(
      client.readContract({
        address: sessions,
        abi: sessionManagerAbi,
        functionName: "tokenSession",
        args: [entry.address],
        ...at,
      }) as Promise<number>,
    ),
  ]);

  return {
    symbol: entry.symbol,
    address: entry.address,
    refPrice: ref.value?.[0] ?? null,
    refUpdatedAt: ref.value?.[1] ?? null,
    refHealthy: ref.value?.[2] ?? null,
    refError: ref.error,
    chainlink: dual.value?.[0] ?? null,
    uniTwap: dual.value?.[1] ?? null,
    agree: dual.value?.[2] ?? null,
    dualError: dual.error,
    stalenessLimit: staleness.value,
    tokenSession: tokenSession.value === null ? null : (tokenSession.value as Session),
  };
}

export async function readSession(
  chainId: number,
  tokens: Array<{symbol: string; address: Address}>,
): Promise<SessionReport> {
  const deployment = deploymentFor(chainId);
  if (deployment === null) {
    throw new Error(`Nokturn is not deployed on chain ${chainId}`);
  }

  const client = clientFor(chainId);
  const block = await client.getBlock();
  const blockNumber = block.number;
  const now = block.timestamp;
  const at = {blockNumber} as const;

  const session = (await client.readContract({
    address: deployment.sessions,
    abi: sessionManagerAbi,
    functionName: "currentSession",
    ...at,
  })) as number;

  const [batchDuration, maxDeviationBps, nextTransition, inGuardBand, easternDay] = await Promise.all([
    client.readContract({
      address: deployment.sessions,
      abi: sessionManagerAbi,
      functionName: "batchDuration",
      args: [session],
      ...at,
    }) as Promise<number>,
    client.readContract({
      address: deployment.sessions,
      abi: sessionManagerAbi,
      functionName: "maxDeviationBps",
      args: [session],
      ...at,
    }) as Promise<number>,
    client.readContract({
      address: deployment.sessions,
      abi: sessionManagerAbi,
      functionName: "nextTransition",
      args: [now],
      ...at,
    }) as Promise<bigint>,
    client.readContract({
      address: deployment.sessions,
      abi: sessionManagerAbi,
      functionName: "inGuardBand",
      args: [now],
      ...at,
    }) as Promise<boolean>,
    client.readContract({
      address: deployment.sessions,
      abi: sessionManagerAbi,
      functionName: "easternDay",
      args: [now],
      ...at,
    }) as Promise<number>,
  ]);

  const oracles = await Promise.all(
    tokens.map((t) => readOracle(chainId, deployment.oracle, deployment.sessions, t, blockNumber)),
  );

  return {
    chainId,
    blockNumber,
    blockTimestamp: now,
    sessionManager: deployment.sessions,
    oracle: deployment.oracle,
    session: session as Session,
    batchDuration,
    maxDeviationBps,
    nextTransition,
    inGuardBand,
    easternDay,
    tokens: oracles,
  };
}
