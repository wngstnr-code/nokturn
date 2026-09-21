// The only sanctioned way to compute a batchId.
//
// Written 20 September 2026 after probing the fork, because the obvious one
// liner is wrong four ways at once and none of them are visible:
//
//   const batchId = Math.ceil(Date.now() / 1000 / 60) * 60;   // do not
//
//   1. Date.now() is the laptop clock. A fork starts at its pinned block's
//      timestamp and runs hours behind, so this lands a batch in the future and
//      every solution comes back SolutionWindowClosed with nothing naming time.
//   2. 60 is only the weekend duration. It becomes 45 overnight and 30 either
//      side of the session, and lcm(60, 45) is 180, so two out of three batchIds
//      revert BatchMisaligned after a session boundary.
//   3. It never asks about the guard band. Worse, asking inGuardBand(now) is
//      not enough either, because Settlement checks inGuardBand(batchId) and the
//      aligned batchId can fall back inside a band the wall clock has left.
//   4. It never handles a zero duration, which is what the two auction phases
//      report, and a zero duration reverts BatchMisaligned.
//
// All four are reproduced by `make postman-resilience`, and the findings are
// written up in docs/rencana-backend.md section 3B.
//
// This module is deliberately free of dependencies. Reads are injected through
// ChainReader so the logic can be exercised without a chain, and the viem backed
// reader lives in batch-viem.ts so importing types does not pull in a client.

/** Settlement.SOLUTION_WINDOW. Read it from the contract rather than trusting this. */
export const DEFAULT_SOLUTION_WINDOW = 10n;

/** SessionManager returns this for AUCTION_OPEN and AUCTION_CLOSE. */
export const NO_ORDINARY_BATCH = 0;

/**
 * Bounded so a misconfigured calendar cannot spin forever. Sixty four matches
 * MAX_TRANSITION_STEPS in SessionManager, and a real search settles in under a
 * dozen even when it has to walk out of a guard band.
 */
const MAX_STEPS = 64;

export interface ChainReader {
  /** block.timestamp of the latest block. Never the caller's own clock. */
  now(): Promise<bigint>;
  sessionAt(timestamp: bigint): Promise<number>;
  batchDuration(session: number): Promise<number>;
  inGuardBand(timestamp: bigint): Promise<boolean>;
  nextTransition(from: bigint): Promise<bigint>;
}

export interface BatchWindow {
  batchId: bigint;
  collectStart: bigint;
  collectEnd: bigint;
  solveEnd: bigint;
  session: number;
  durationSeconds: number;
}

export type NoBatchReason =
  /** The session runs no ordinary batch at all, which is both auction phases. */
  | "auction_phase"
  /** A session boundary is close enough that no aligned batchId is outside it. */
  | "guard_band"
  /** Asked for a solvable batch while the ten second window is shut. */
  | "window_closed"
  /** The calendar walk hit its step limit, which means something is wrong. */
  | "search_exhausted";

export interface NoBatch {
  batchId: null;
  reason: NoBatchReason;
  /** When the search knows one, the first time worth asking again. */
  retryAt: bigint | null;
}

export type BatchLookup = BatchWindow | NoBatch;

export function isBatch(result: BatchLookup): result is BatchWindow {
  return result.batchId !== null;
}

/**
 * The windows Settlement.batchWindow derives, reproduced without a call.
 * Kept separate so a caller that already holds a batchId does not pay a read.
 */
export function windowOf(
  batchId: bigint,
  durationSeconds: number,
  session: number,
  solutionWindow: bigint = DEFAULT_SOLUTION_WINDOW,
): BatchWindow {
  const duration = BigInt(durationSeconds);
  return {
    batchId,
    collectStart: batchId - duration,
    collectEnd: batchId,
    solveEnd: batchId + solutionWindow,
    session,
    durationSeconds,
  };
}

/**
 * The batch currently collecting, meaning the smallest valid batchId strictly
 * after `from`. This is what a coordinator opens intents against.
 *
 * Validity is exactly what Settlement.batchWindow enforces. A batchId is valid
 * when its own session reports a non zero duration, the id divides by that
 * duration, and inGuardBand is false at the id itself.
 */
export async function nextValidBatchId(
  reader: ChainReader,
  from?: bigint,
  solutionWindow: bigint = DEFAULT_SOLUTION_WINDOW,
): Promise<BatchLookup> {
  const start = from ?? (await reader.now());
  let cursor = start + 1n;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const session = await reader.sessionAt(cursor);
    const duration = await reader.batchDuration(session);

    if (duration === NO_ORDINARY_BATCH) {
      // An auction phase runs no ordinary batch at all. Skipping to the next
      // transition rather than stepping second by second, because these phases
      // are half an hour wide and MAX_STEPS would run out long before.
      const transition = await reader.nextTransition(cursor);
      if (transition <= cursor) {
        return {batchId: null, reason: "auction_phase", retryAt: null};
      }
      cursor = transition;
      continue;
    }

    const d = BigInt(duration);
    const aligned = ((cursor + d - 1n) / d) * d;

    // Aligning can cross a session boundary, and the far side may run a
    // different duration. Re-ask rather than assume, which is finding R5.
    if (aligned !== cursor) {
      cursor = aligned;
      continue;
    }

    // The check Settlement makes is about the batchId, not about now. An id one
    // duration past a boundary can still sit inside the band. Finding R4.
    if (await reader.inGuardBand(cursor)) {
      cursor += 1n;
      continue;
    }

    return windowOf(cursor, duration, session, solutionWindow);
  }

  return {batchId: null, reason: "search_exhausted", retryAt: cursor};
}

/**
 * The batch whose solution window is open right now, or null.
 *
 * Settlement accepts a solution only while `collectEnd < now <= solveEnd`, which
 * is ten seconds out of every batch. At weekend duration that is one second in
 * six. A solver that starts thinking when the batch closes has already lost, so
 * this exists to be polled, not to be guessed at. Finding R2.
 */
export async function solvableBatchId(
  reader: ChainReader,
  at?: bigint,
  solutionWindow: bigint = DEFAULT_SOLUTION_WINDOW,
): Promise<BatchLookup> {
  const now = at ?? (await reader.now());

  // The candidate is the most recent boundary at or before now. Its duration
  // comes from its own session, so derive the session from the candidate rather
  // than from now, which can already be on the other side of a transition.
  const sessionNow = await reader.sessionAt(now);
  const durationNow = await reader.batchDuration(sessionNow);
  if (durationNow === NO_ORDINARY_BATCH) {
    return {batchId: null, reason: "auction_phase", retryAt: null};
  }

  const d = BigInt(durationNow);
  const candidate = (now / d) * d;

  if (candidate >= now || now > candidate + solutionWindow) {
    // Shut rather than absent. The next opening is one second after the next
    // boundary, and saying so is what lets a solver sleep instead of spin.
    const next = await nextValidBatchId(reader, now, solutionWindow);
    return {
      batchId: null,
      reason: "window_closed",
      retryAt: isBatch(next) ? next.collectEnd + 1n : null,
    };
  }

  // The candidate carries its own session, which can differ from the one at
  // now when a boundary sits between them.
  const session = await reader.sessionAt(candidate);
  const duration = await reader.batchDuration(session);
  if (duration === NO_ORDINARY_BATCH || candidate % BigInt(duration) !== 0n) {
    return {batchId: null, reason: "auction_phase", retryAt: null};
  }
  if (await reader.inGuardBand(candidate)) {
    return {batchId: null, reason: "guard_band", retryAt: null};
  }

  return windowOf(candidate, duration, session, solutionWindow);
}

/**
 * Whether Settlement.batchWindow would accept this id, decided with the same
 * three questions it asks. Cheap enough to assert before sending a transaction.
 */
export async function isValidBatchId(reader: ChainReader, batchId: bigint): Promise<boolean> {
  const session = await reader.sessionAt(batchId);
  const duration = await reader.batchDuration(session);
  if (duration === NO_ORDINARY_BATCH) return false;
  if (batchId % BigInt(duration) !== 0n) return false;
  return !(await reader.inGuardBand(batchId));
}
