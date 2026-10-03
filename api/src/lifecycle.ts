// Opens and closes batches by watching blocks, and announces what changed.
//
// Time is the block's timestamp and nothing else. A fork runs hours behind the
// laptop clock, so a lifecycle driven by Date.now() would close batches the
// chain has not reached.
//
// It sends no transaction, and it publishes only what a chain read or the
// mempool can back. What AuctionHouse and Settlement emitted is announced by
// announce.ts, from their logs and, for a finished batch, the indexer's receipt.

import type {FastifyBaseLogger} from "fastify";
import type {Address} from "../../packages/shared/api-types.ts";
import {createAnnouncer} from "./announce.ts";
import {chain, oracleAbi, read, revertReason, rpcRequestCount, sessionAbi} from "./chain.ts";
import {publish} from "./events.ts";
import {FINALIZE_DEADLINE, counts} from "./mempool.ts";
import {sawHead, type BlockStamp} from "./provenance.ts";
import {isCollectClosed} from "./routes/intents.ts";
import {FROZEN_SESSIONS, WEEKEND_DRIFT_CAP_BPS, buildCurrentBatch, buildSession, rememberCurrent} from "./routes/session.ts";

const POLLING_INTERVAL_MS = 500;
const MAX_TRACKED = 8;
const PROTECTIVE = 8;

/** A block to tick on. The timestamp is there when the poll already read it. */
interface Head {
  number: bigint;
  timestamp?: bigint;
}

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
});

export function startLifecycle(log: FastifyBaseLogger): () => void {
  let state = fresh();
  /** The latest chain second a close was published at, so an open never goes out stamped earlier. */
  let closedAt: bigint | null = null;
  const announcer = createAnnouncer(log);
  let running = false;
  let queued: Head | null = null;
  // Counted rather than assumed, so the log can show the no overlap rule holds.
  let inFlight = 0;

  // Closed first, before any read. A close needs nothing but a block timestamp,
  // and solvers start on this frame with ten seconds to submit. It used to wait
  // behind every read in the tick, and on mainnet from Railway it came 16 to 43
  // seconds late, after the window had shut, on every batch measured on
  // 2 October 2026. Called by the poll as well while a tick is still busy, so a
  // slow read delays only the frames that need it. Synchronous, so it can never
  // interleave with itself, and it still lands before the successor's open.
  function closeDue(T: bigint): void {
    for (const [id, t] of state.tracked) {
      if (!t.closed && isCollectClosed(id, T)) {
        t.closed = true;
        if (closedAt === null || T > closedAt) closedAt = T;
        publish({
          type: "batch.collect_closed",
          at: Number(T),
          data: {batchId: String(id), intentCount: counts(id).intentCount, solveEndsAt: Number(t.solveEnd)},
        });
      }
      if (T > t.solveEnd + FINALIZE_DEADLINE) state.tracked.delete(id);
    }
  }

  async function tick(head: Head): Promise<void> {
    inFlight += 1;
    try {
      await tickOnce(head, inFlight);
    } finally {
      inFlight -= 1;
    }
  }

  // On a real chain the poll has already read the head block, so its timestamp
  // is passed in rather than asked for again on the path to a close.
  async function tickOnce(head: Head, concurrent: number): Promise<void> {
    const c = chain();
    const readsBefore = rpcRequestCount();
    const blockNumber = head.number;
    const at: BlockStamp = head.timestamp !== undefined ? {number: head.number, timestamp: head.timestamp} : await c.client.getBlock({blockNumber}).then((b) => ({number: b.number, timestamp: b.timestamp}));
    const T = at.timestamp;

    // An evm_revert or a fork restart. Everything tracked belongs to a history
    // the chain no longer has, so it is dropped rather than closed.
    if (state.lastTime !== null && T < state.lastTime) {
      log.warn({block: String(blockNumber), from: String(state.lastTime), to: String(T)}, "chain time went backwards, lifecycle state cleared");
      state = fresh();
      closedAt = null;
      announcer.reset();
    }
    state.lastTime = T;

    closeDue(T);

    // Its own failure is logged, not the tick's, and health reads a failed tick
    // as a dead scheduler. Started with the reads below and awaited on every
    // path out, because its log cursor must never be stepped by two ticks.
    const announced = announcer.step(at).catch((error: unknown) => log.warn({err: error}, "contract logs not announced this tick, retried on the next"));
    try {
      await afterClose(at);
    } finally {
      await announced;
    }

    log.debug({block: String(blockNumber), chainTime: String(T), reads: rpcRequestCount() - readsBefore, tracked: state.tracked.size, concurrent}, "lifecycle tick");
  }

  // The reads here do not depend on one another, so they all go out at once,
  // one round trip where there were four. The open is published as soon as its
  // own read is back, never behind the oracle or session reads, so a slow or
  // stuck price read cannot hold a batch shut. The frames keep the old order,
  // opened, session, protective, oracle.
  async function afterClose(at: BlockStamp): Promise<void> {
    const c = chain();
    const T = at.timestamp;
    const others = Promise.allSettled([
      read<number>(c.deployment.sessions, sessionAbi, "currentSession", [], at.number),
      // In parallel, so a chain with Multicall3 answers every token in one call.
      Promise.all(c.tokens.map((t) => read<number>(c.deployment.sessions, sessionAbi, "tokenSession", [t.token], at.number))),
      Promise.all(
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
      ),
    ]);
    const current = await buildCurrentBatch(at);
    rememberCurrent(current);

    // In the very second a batch's collectEnd is reached, the contract still
    // takes it as collecting while openWindow already names its successor. The
    // open waits for the close a second later, so a listener always hears a
    // batch end before the next begins. Seen on mainnet once ticks got fast
    // enough to land on that second, 2 October 2026 (N32).
    const older = (id: bigint) => [...state.tracked].some(([tracked, t]) => !t.closed && tracked < id);
    if (current.batchId !== null && !older(BigInt(current.batchId))) {
      const id = BigInt(current.batchId);
      if (id !== state.current) {
        state.current = id;
        state.tracked.set(id, {collectEnd: BigInt(current.collectEndsAt), solveEnd: BigInt(current.solveEndsAt), closed: false});
        // A poll may have closed the batch before at a later second than this
        // tick's own, and a frame never carries an earlier time than one sent
        // before it.
        publish({type: "batch.opened", at: Number(closedAt !== null && closedAt > T ? closedAt : T), data: current});
      }
    }

    // After the open, so the batch just added counts against the cap. Only
    // closed batches are evicted, so the cap can never swallow a close.
    for (const [id, t] of state.tracked) {
      if (state.tracked.size <= MAX_TRACKED) break;
      if (t.closed) state.tracked.delete(id);
    }

    const [sessionRead, tokenRead, priceRead] = await others;
    if (sessionRead.status === "rejected") throw sessionRead.reason;
    const session = sessionRead.value;
    if (state.session !== null && session !== state.session) {
      publish({type: "session.changed", at: Number(T), data: await buildSession(at)});
    }
    state.session = session;

    if (tokenRead.status === "rejected") throw tokenRead.reason;
    const tokenSessions = new Map<Address, number>();
    c.tokens.forEach((t, i) => tokenSessions.set(t.token, tokenRead.value[i]!));
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

    if (priceRead.status === "rejected") throw priceRead.reason;
    const prices = priceRead.value;
    const healthy = new Map<Address, boolean>();
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
  }

  // Never two ticks at once, and never more than one waiting. A slow node
  // makes the lifecycle late, not concurrent, and a late tick catches up in
  // one step because every tick reads the present rather than replaying.
  async function drive(head: Head): Promise<void> {
    if (running) {
      queued = head;
      // Never on a timestamp below the last one, which is a revert the next tick
      // has to see first.
      if (head.timestamp !== undefined && state.lastTime !== null && head.timestamp >= state.lastTime) closeDue(head.timestamp);
      return;
    }
    running = true;
    let next: Head | null = head;
    while (next !== null) {
      queued = null;
      try {
        await tick(next);
        lastTickAt = Date.now();
      } catch (error) {
        log.error({err: error, block: String(next.number)}, "lifecycle tick failed");
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
          void drive({number: n});
        }
      } else {
        const head = await chain().client.getBlock();
        sawHead({number: head.number, timestamp: head.timestamp});
        if (head.timestamp !== lastTime) {
          lastTime = head.timestamp;
          void drive({number: head.number, timestamp: head.timestamp});
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
