// Opens and closes batches by watching blocks, and announces what changed.
//
// Time is the block's timestamp and nothing else. A fork runs hours behind the
// laptop clock, so a lifecycle driven by Date.now() would close batches the
// chain has not reached.
//
// It sends no transaction, and it publishes only what a chain read or the
// mempool can back, plus the auction events AuctionHouse itself emitted.
// Settlement outcomes need the indexer, and nothing here pretends to know them.

import type {FastifyBaseLogger} from "fastify";
import {parseEventLogs, type AbiEvent} from "viem";
import type {Address} from "../../packages/shared/api-types.ts";
import {chain, oracleAbi, read, revertReason, rpcRequestCount, sessionAbi} from "./chain.ts";
import {env} from "./config.ts";
import {publish} from "./events.ts";
import {auctionHouseAbi, buildAuction} from "./routes/auctions.ts";
import {FINALIZE_DEADLINE, counts} from "./mempool.ts";
import type {BlockStamp} from "./provenance.ts";
import {isCollectClosed} from "./routes/intents.ts";
import {FROZEN_SESSIONS, WEEKEND_DRIFT_CAP_BPS, buildCurrentBatch, buildSession} from "./routes/session.ts";

const POLLING_INTERVAL_MS = 500;
const MAX_TRACKED = 8;
const PROTECTIVE = 8;
// Bounds the log reads one tick makes after a stall. The rest waits for the next.
const MAX_LOG_CHUNKS_PER_TICK = 20;
// CrossExecuted rather than CrossSubmitted, because a submitted cross can still
// be challenged and rolled back, and an executed one is what paid out.
const AUCTION_EVENTS = auctionHouseAbi.filter(
  (item): item is AbiEvent => item.type === "event" && (item.name === "IndicativePublished" || item.name === "CrossExecuted"),
);

interface Tracked {
  collectEnd: bigint;
  solveEnd: bigint;
  closed: boolean;
}

interface State {
  lastTime: bigint | null;
  current: bigint | null;
  tracked: Map<bigint, Tracked>;
  session: number | null;
  tokenSessions: Map<Address, number> | null;
  healthy: Map<Address, boolean> | null;
  auctionsFrom: bigint | null;
}

/** Wall clock of the last tick that completed, for /v1/health. Null before the first. */
let lastTickAt: number | null = null;
export const lastLifecycleTick = (): number | null => lastTickAt;

const fresh = (): State => ({
  lastTime: null,
  current: null,
  tracked: new Map(),
  session: null,
  tokenSessions: null,
  healthy: null,
  auctionsFrom: null,
});

export function startLifecycle(log: FastifyBaseLogger): () => void {
  let state = fresh();
  let running = false;
  let queued: bigint | null = null;
  // Counted rather than assumed, so the log can show the no overlap rule holds.
  let inFlight = 0;

  async function tick(blockNumber: bigint): Promise<void> {
    inFlight += 1;
    try {
      await tickOnce(blockNumber, inFlight);
    } finally {
      inFlight -= 1;
    }
  }

  async function tickOnce(blockNumber: bigint, concurrent: number): Promise<void> {
    const c = chain();
    const readsBefore = rpcRequestCount();
    const block = await c.client.getBlock({blockNumber});
    const at: BlockStamp = {number: block.number, timestamp: block.timestamp};
    const T = at.timestamp;

    // An evm_revert or a fork restart. Everything tracked belongs to a history
    // the chain no longer has, so it is dropped rather than closed.
    if (state.lastTime !== null && T < state.lastTime) {
      log.warn({block: String(blockNumber), from: String(state.lastTime), to: String(T)}, "chain time went backwards, lifecycle state cleared");
      state = fresh();
    }
    state.lastTime = T;

    const current = await buildCurrentBatch(at);

    // Closed before the next one is opened, so a listener sees each batch end
    // before its successor begins even when both happen on one block.
    for (const [id, t] of state.tracked) {
      if (!t.closed && isCollectClosed(id, T)) {
        t.closed = true;
        publish({
          type: "batch.collect_closed",
          at: Number(T),
          data: {batchId: String(id), intentCount: counts(id).intentCount, solveEndsAt: Number(t.solveEnd)},
        });
      }
      if (T > t.solveEnd + FINALIZE_DEADLINE) state.tracked.delete(id);
    }

    if (current.batchId !== null) {
      const id = BigInt(current.batchId);
      if (id !== state.current) {
        state.current = id;
        state.tracked.set(id, {collectEnd: BigInt(current.collectEndsAt), solveEnd: BigInt(current.solveEndsAt), closed: false});
        publish({type: "batch.opened", at: Number(T), data: current});
      }
    }

    // After the open, so the batch just added counts against the cap. Only
    // closed batches are evicted, so the cap can never swallow a close.
    for (const [id, t] of state.tracked) {
      if (state.tracked.size <= MAX_TRACKED) break;
      if (t.closed) state.tracked.delete(id);
    }

    const session = await read<number>(c.deployment.sessions, sessionAbi, "currentSession", [], at.number);
    if (state.session !== null && session !== state.session) {
      publish({type: "session.changed", at: Number(T), data: await buildSession(at)});
    }
    state.session = session;

    // In parallel, so a chain with Multicall3 answers every token in one call.
    const tokenSessions = new Map<Address, number>();
    const sessionReads = await Promise.all(c.tokens.map((t) => read<number>(c.deployment.sessions, sessionAbi, "tokenSession", [t.token], at.number)));
    c.tokens.forEach((t, i) => tokenSessions.set(t.token, sessionReads[i]!));
    if (state.tokenSessions !== null) {
      for (const t of c.tokens) {
        const was = state.tokenSessions.get(t.token) === PROTECTIVE;
        const is = tokenSessions.get(t.token) === PROTECTIVE;
        if (was === is) continue;
        publish({
          type: "token.protective",
          at: Number(T),
          data: {token: t.token, symbol: t.symbol, reason: is ? "token is in PROTECTIVE" : "token left PROTECTIVE", cleared: !is},
        });
      }
    }
    state.tokenSessions = tokenSessions;

    const healthy = new Map<Address, boolean>();
    const prices = await Promise.all(
      c.tokens.map((t) =>
        read<[bigint, bigint, boolean]>(c.deployment.oracle, oracleAbi, "refPrice", [t.token], at.number).then(
          (answer) => answer,
          (error: unknown) => {
            // A token with no source reverts on every block. That is a fact the
            // solver feed already reports by name, not a transition to announce.
            if (revertReason(error) === null) throw error;
            return null;
          },
        ),
      ),
    );
    for (const [i, t] of c.tokens.entries()) {
      const answer = prices[i];
      if (!answer) continue;
      const [, updatedAt, ok] = answer;
      healthy.set(t.token, ok);
      if (ok || state.healthy === null || state.healthy.get(t.token) !== true) continue;

      // PriceOracle.refPrice takes the TWAP branch only on a frozen session and
      // only for a token with a TWAP source. There, unhealthy is the TWAP
      // drifting past the cap against the Friday anchor. Everywhere else it is
      // the Chainlink round being older than the limit. Read on the transition
      // only, so the extra call costs nothing on an ordinary block.
      const [twapAdapter] = await read<[Address, Address, number]>(c.deployment.oracle, oracleAbi, "twapSources", [t.token], at.number);
      const frozen = FROZEN_SESSIONS.has(tokenSessions.get(t.token)!) && BigInt(twapAdapter) !== 0n;
      const detail = frozen
        ? `TWAP drifted more than ${WEEKEND_DRIFT_CAP_BPS} bps from the Chainlink anchor`
        : `Chainlink round from ${updatedAt} is ${T - updatedAt}s old, past the limit of ${await read<number>(c.deployment.oracle, oracleAbi, "stalenessLimit", [t.token], at.number)}s`;
      publish({type: "oracle.unhealthy", at: Number(T), data: {token: t.token, symbol: t.symbol, reason: frozen ? "disagreement" : "stale", detail}});
    }
    state.healthy = healthy;

    // Its own failure is logged, not the tick's. The batch and session work above
    // already happened, and health reads a failed tick as a dead scheduler.
    await announceAuctions(at).catch((error: unknown) => log.warn({err: error}, "auction logs not read this tick, retried on the next"));

    log.debug({block: String(blockNumber), chainTime: String(T), reads: rpcRequestCount() - readsBefore, tracked: state.tracked.size, concurrent}, "lifecycle tick");
  }

  // Read from AuctionHouse logs rather than from the keeper, so an auction any
  // keeper drives is announced, and the body is the same one the REST route
  // builds at the block that emitted the log.
  async function announceAuctions(at: BlockStamp): Promise<void> {
    if (state.auctionsFrom === null || state.auctionsFrom > at.number) {
      state.auctionsFrom = at.number + 1n;
      return;
    }
    // In chunks the endpoint accepts, a bounded number per tick, and never
    // skipping a range. The cursor moves only past what was read, so a failed
    // read is tried again on the next tick.
    let cursor: bigint = state.auctionsFrom;
    for (let chunk = 0; chunk < MAX_LOG_CHUNKS_PER_TICK && cursor <= at.number; chunk += 1) {
      const fromBlock: bigint = cursor;
      const last = fromBlock + env.logBlockRange - 1n;
      const toBlock: bigint = last < at.number ? last : at.number;
      const raw = await chain().client.getLogs({address: chain().deployment.auctionHouse, fromBlock, toBlock});
      for (const entry of parseEventLogs({abi: AUCTION_EVENTS, logs: raw})) {
        const type = entry.eventName === "IndicativePublished" ? "auction.indicative" : "auction.crossed";
        const blockNumber = entry.blockNumber!;
        const {timestamp} = await chain().client.getBlock({blockNumber});
        const body = await buildAuction((entry.args as {auctionId: bigint}).auctionId, {number: blockNumber, timestamp});
        if (body) publish({type, at: Number(timestamp), data: body});
      }
      cursor = toBlock + 1n;
      state.auctionsFrom = cursor;
    }
  }

  // Never two ticks at once, and never more than one waiting. A slow node
  // makes the lifecycle late, not concurrent, and a late tick catches up in
  // one step because every tick reads the present rather than replaying.
  async function drive(blockNumber: bigint): Promise<void> {
    if (running) {
      queued = blockNumber;
      return;
    }
    running = true;
    let next: bigint | null = blockNumber;
    while (next !== null) {
      queued = null;
      try {
        await tick(next);
        lastTickAt = Date.now();
      } catch (error) {
        log.error({err: error, block: String(next)}, "lifecycle tick failed");
      }
      next = queued;
    }
    running = false;
  }

  // Polled here rather than through viem's watchBlockNumber, which only emits a
  // number above the last one it saw. After an evm_revert the head drops, and
  // the lifecycle would sit silent until the chain climbed past its old height,
  // with no batch closing and every solver waiting.
  //
  // On a real chain once per second of chain time rather than once per block.
  // Mainnet seals about ten blocks a second under one timestamp, and every
  // batch boundary, session and feed age is in whole seconds, so the other
  // nine ticks read the same answers again. A fork keeps one tick per block,
  // since the torture suites drive it block by block.
  const perBlock = chain().isFork;
  let last: bigint | null = null;
  let lastTime: bigint | null = null;
  let stopped = false;
  const poll = async () => {
    if (stopped) return;
    try {
      if (perBlock) {
        const n = await chain().client.getBlockNumber({cacheTime: 0});
        if (n !== last) {
          last = n;
          void drive(n);
        }
      } else {
        const head = await chain().client.getBlock();
        if (head.timestamp !== lastTime) {
          lastTime = head.timestamp;
          void drive(head.number);
        }
      }
    } catch (error) {
      log.error({err: error}, "block watch failed");
    }
    if (!stopped) timer = setTimeout(poll, POLLING_INTERVAL_MS);
  };
  let timer = setTimeout(poll, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
