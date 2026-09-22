// Opens and closes batches by watching blocks, and announces what changed.
//
// Time is the block's timestamp and nothing else. A fork runs hours behind the
// laptop clock, so a lifecycle driven by Date.now() would close batches the
// chain has not reached.
//
// It sends no transaction, and it publishes only what a chain read or the
// mempool can back. Settlement outcomes and auction events need the indexer and
// the auction keeper, and until those exist nothing here pretends to know them.

import type {FastifyBaseLogger} from "fastify";
import type {Address} from "../../packages/shared/api-types.ts";
import {chain, oracleAbi, read, revertReason, rpcRequestCount, sessionAbi} from "./chain.ts";
import {publish} from "./events.ts";
import {FINALIZE_DEADLINE, counts} from "./mempool.ts";
import type {BlockStamp} from "./provenance.ts";
import {isCollectClosed} from "./routes/intents.ts";
import {FROZEN_SESSIONS, WEEKEND_DRIFT_CAP_BPS, buildCurrentBatch, buildSession} from "./routes/session.ts";

const POLLING_INTERVAL_MS = 500;
const MAX_TRACKED = 8;
const PROTECTIVE = 8;

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
}

const fresh = (): State => ({
  lastTime: null,
  current: null,
  tracked: new Map(),
  session: null,
  tokenSessions: null,
  healthy: null,
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
    // Only closed batches are evicted, so a cap can never swallow a close.
    for (const [id, t] of state.tracked) {
      if (state.tracked.size <= MAX_TRACKED) break;
      if (t.closed) state.tracked.delete(id);
    }

    if (current.batchId !== null) {
      const id = BigInt(current.batchId);
      if (id !== state.current) {
        state.current = id;
        state.tracked.set(id, {collectEnd: BigInt(current.collectEndsAt), solveEnd: BigInt(current.solveEndsAt), closed: false});
        publish({type: "batch.opened", at: Number(T), data: current});
      }
    }

    const session = await read<number>(c.deployment.sessions, sessionAbi, "currentSession", [], at.number);
    if (state.session !== null && session !== state.session) {
      publish({type: "session.changed", at: Number(T), data: await buildSession(at)});
    }
    state.session = session;

    const tokenSessions = new Map<Address, number>();
    for (const t of c.tokens) {
      tokenSessions.set(t.token, await read<number>(c.deployment.sessions, sessionAbi, "tokenSession", [t.token], at.number));
    }
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
    for (const t of c.tokens) {
      let answer: [bigint, bigint, boolean];
      try {
        answer = await read<[bigint, bigint, boolean]>(c.deployment.oracle, oracleAbi, "refPrice", [t.token], at.number);
      } catch (error) {
        // A token with no source reverts on every block. That is a fact the
        // solver feed already reports by name, not a transition to announce.
        if (revertReason(error) === null) throw error;
        continue;
      }
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

    log.debug({block: String(blockNumber), chainTime: String(T), reads: rpcRequestCount() - readsBefore, tracked: state.tracked.size, concurrent}, "lifecycle tick");
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
      } catch (error) {
        log.error({err: error, block: String(next)}, "lifecycle tick failed");
      }
      next = queued;
    }
    running = false;
  }

  return chain().client.watchBlockNumber({
    pollingInterval: POLLING_INTERVAL_MS,
    emitMissed: false,
    onBlockNumber: (n) => void drive(n),
    onError: (error) => log.error({err: error}, "block watch failed"),
  });
}
