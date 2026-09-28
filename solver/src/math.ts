// The contract's arithmetic, in BigInt, operation for operation.
//
// Predicates come from contracts/src/libraries/ClearingMath.sol, the savings sum
// from ClearingVerifier.verify, the venue deltas from Settlement._venueDeltas and
// the exposure figures from Settlement._chargeExposure. Every floor sits where
// the contract's integer division sits. Moving one, even to "tidy" a formula,
// produces SavingsMismatch or ValueNotConserved on chain.

import type {Address} from "viem";
import {tokenIndex, type Execution, type Intent, type Solution, type VenueCall} from "./solution.ts";

export const WAD = 10n ** 18n;
export const BPS = 10_000n;

/** Settlement constants, parameter.md section 6. */
export const FEE_CAP_SHARE_BPS = 2000n;
export const FEE_CAP_NOTIONAL_BPS = 3n;

export function limitRespected(executedBuy: bigint, sellAmount: bigint, minBuyAmount: bigint, executedSell: bigint): boolean {
  return executedBuy * sellAmount >= minBuyAmount * executedSell;
}

export function feeWithinBand(valueIn: bigint, valueOut: bigint, maxFeeBps: bigint): boolean {
  if (valueOut > valueIn) return false;
  return (valueIn - valueOut) * BPS <= valueIn * maxFeeBps;
}

export function withinBand(price: bigint, ref: bigint, maxDeviationBps: bigint): boolean {
  const diff = price > ref ? price - ref : ref - price;
  return diff * BPS <= ref * maxDeviationBps;
}

export function conserved(pulled: bigint, venueDelta: bigint, delivered: bigint): bigint {
  return pulled + venueDelta - delivered;
}

export function feeCap(surplusUsd: bigint, notionalUsd: bigint, shareBps = FEE_CAP_SHARE_BPS, notionalBps = FEE_CAP_NOTIONAL_BPS): bigint {
  const byShare = (surplusUsd * shareBps) / BPS;
  const byNotional = (notionalUsd * notionalBps) / BPS;
  return byShare < byNotional ? byShare : byNotional;
}

/** ClearingVerifier._checkUniformPrice, the per execution fee ceiling. */
export function uniformPriceHolds(executedSell: bigint, executedBuy: bigint, sellPrice: bigint, buyPrice: bigint, maxFeeBps = FEE_CAP_NOTIONAL_BPS): boolean {
  return feeWithinBand(executedSell * sellPrice, executedBuy * buyPrice, maxFeeBps);
}

/**
 * Settlement._verify refuses a direction whose baselines sum below the venue's
 * quote on that direction's whole volume, BaselineBelowVenue. Per intent quotes
 * each round down and each pay the fee rounded up, so on small tickets their sum
 * lands a few units under the one quote on the total, measured in the August
 * replay. The shortfall is added to the fills with the most room under their
 * executedBuy, which only lowers the savings claimed. Null when the room is not
 * there, and then the direction cannot be netted.
 */
export function raiseToFloor(baselines: readonly bigint[], executedBuys: readonly bigint[], floor: bigint): bigint[] | null {
  const out = [...baselines];
  let short = floor - out.reduce((a, b) => a + b, 0n);
  const byRoom = out.map((_, k) => k).sort((a, b) => {
    const d = executedBuys[b]! - out[b]! - (executedBuys[a]! - out[a]!);
    return d > 0n ? 1 : d < 0n ? -1 : a - b;
  });
  for (const k of byRoom) {
    if (short <= 0n) break;
    const room = executedBuys[k]! - out[k]!;
    const add = room < short ? room : short;
    if (add > 0n) {
      out[k] = out[k]! + add;
      short -= add;
    }
  }
  return short > 0n ? null : out;
}

/**
 * The savings verify returns. Floored per execution inside the loop, exactly as
 * the contract does, never once over the total.
 */
export function claimedSavings(
  executions: readonly Execution[],
  baselineQuotes: readonly bigint[],
  prices: readonly bigint[],
  intents: readonly Intent[],
  tokens: readonly Address[],
): bigint {
  if (executions.length !== baselineQuotes.length) throw new Error("one baseline per execution");
  let savings = 0n;
  executions.forEach((e, k) => {
    const i = intents[Number(e.intentIndex)];
    if (!i) throw new Error(`execution ${k} names intent ${e.intentIndex}, which does not exist`);
    const baseline = baselineQuotes[k]!;
    if (e.executedBuy < baseline) throw new Error(`execution ${k} is worse than its baseline, WorseThanBaseline`);
    savings += ((e.executedBuy - baseline) * prices[tokenIndex(tokens, i.buyToken)]!) / WAD;
  });
  return savings;
}

/** Settlement._venueDeltas. minOut, not the expected output, is what gets credited. */
export function venueDeltas(venueCalls: readonly VenueCall[], tokens: readonly Address[]): bigint[] {
  const deltas = tokens.map(() => 0n);
  for (const call of venueCalls) {
    deltas[tokenIndex(tokens, call.tokenIn)]! -= call.amountIn;
    deltas[tokenIndex(tokens, call.tokenOut)]! += call.minOut;
  }
  return deltas;
}

/** Per token balance after the batch, the quantity _checkConservation requires to be non negative. */
export function conservation(s: Pick<Solution, "intents" | "executions" | "venueCalls" | "tokens">): bigint[] {
  const pulled = s.tokens.map(() => 0n);
  const delivered = s.tokens.map(() => 0n);
  for (const e of s.executions) {
    const i = s.intents[Number(e.intentIndex)]!;
    pulled[tokenIndex(s.tokens, i.sellToken)]! += e.executedSell;
    delivered[tokenIndex(s.tokens, i.buyToken)]! += e.executedBuy;
  }
  const deltas = venueDeltas(s.venueCalls, s.tokens);
  return s.tokens.map((_, t) => conserved(pulled[t]!, deltas[t]!, delivered[t]!));
}

export interface Exposure {
  /** Settlement._notionalUsd, every execution's sell side at the solution's own price. */
  notionalUsd: bigint;
  /** Settlement._tokenNotional per entry of s.tokens. */
  perToken: bigint[];
}

export function exposureNotional(s: Pick<Solution, "intents" | "executions" | "tokens" | "prices">): Exposure {
  let notionalUsd = 0n;
  const perToken = s.tokens.map(() => 0n);
  for (const e of s.executions) {
    const i = s.intents[Number(e.intentIndex)]!;
    const t = tokenIndex(s.tokens, i.sellToken);
    const usd = (e.executedSell * s.prices[t]!) / WAD;
    notionalUsd += usd;
    perToken[t]! += usd;
  }
  return {notionalUsd, perToken};
}

/** Settlement._capScale. Weekend, holiday and PROTECTIVE halve every cap. */
export function capScale(session: number): bigint {
  return session === 6 || session === 7 || session === 8 ? 1n : 2n;
}

export interface ExposureState {
  capPerBatchUsd: bigint;
  capPerTokenDailyUsd: bigint;
  capGlobalDailyUsd: bigint;
  /** Settlement.today, already rolled to zero when its index is not the day finalize will land on. */
  globalToday: bigint;
  /** perTokenOnDay for that same day, one entry per s.tokens. */
  perTokenToday: bigint[];
}

/**
 * What _chargeExposure would refuse at finalize, in the order it checks. The
 * contract checks this only at finalize, after the solver is already committed,
 * so a solution that fails here is never submitted.
 */
export function exposureViolations(exposure: Exposure, session: number, state: ExposureState): string[] {
  const scale = capScale(session);
  const out: string[] = [];
  const batchCap = (state.capPerBatchUsd * scale) / 2n;
  if (exposure.notionalUsd > batchCap) out.push(`batch ${exposure.notionalUsd} over ${batchCap}`);
  const global = state.globalToday + exposure.notionalUsd;
  const globalCap = (state.capGlobalDailyUsd * scale) / 2n;
  if (global > globalCap) out.push(`global ${global} over ${globalCap}`);
  const tokenCap = (state.capPerTokenDailyUsd * scale) / 2n;
  exposure.perToken.forEach((usd, t) => {
    const spent = (state.perTokenToday[t] ?? 0n) + usd;
    if (spent > tokenCap) out.push(`token ${t} ${spent} over ${tokenCap}`);
  });
  return out;
}
