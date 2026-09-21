// Reads the session calendar straight from SessionManager, so a scenario that
// needs a given session finds it on chain rather than from a hardcoded date.

import {abis, ctx} from "./sign.mjs";

const read = (functionName, args) =>
  ctx.client.readContract({address: ctx.deployment.sessions, abi: abis.session, functionName, args});

export const SESSION = {
  CLOSED_OVERNIGHT: 0,
  PRE_MARKET: 1,
  AUCTION_OPEN: 2,
  OPEN: 3,
  AUCTION_CLOSE: 4,
  POST_MARKET: 5,
  CLOSED_WEEKEND: 6,
  HOLIDAY: 7,
};

export const sessionAt = async (ts) => Number(await read("sessionAt", [BigInt(ts)]));
export const nextTransition = async (ts) => BigInt(await read("nextTransition", [BigInt(ts)]));
export const inGuardBand = async (ts) => read("inGuardBand", [BigInt(ts)]);
export const batchDuration = async (session) => Number(await read("batchDuration", [session]));

/** The first moment at or after `from` when the calendar enters `session`. */
export async function findSessionStart(session, from, maxSteps = 2000) {
  let t = BigInt(from);
  if ((await sessionAt(t)) === session) return t;
  for (let step = 0; step < maxSteps; step += 1) {
    const next = await nextTransition(t);
    if (next <= t) throw new Error(`calendar did not advance past ${t}`);
    t = next;
    if ((await sessionAt(t)) === session) return t;
  }
  throw new Error(`session ${session} not found within ${maxSteps} transitions of ${from}`);
}

/** The first second after `from` that is outside every guard band. */
export async function leaveGuardBand(from, maxSeconds = 3600) {
  let t = BigInt(from);
  for (let i = 0; i < maxSeconds; i += 1) {
    if (!(await inGuardBand(t))) return t;
    t += 1n;
  }
  throw new Error(`still inside a guard band ${maxSeconds}s after ${from}`);
}
