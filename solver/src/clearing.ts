// Clearing one base token against the quote asset. desain-kliring.md sections
// 2 to 5, held to what the contracts actually check.
//
// Two price units meet here, and mixing them is the easiest bug to write.
//   pair price p   quote smallest units per base smallest unit, times 1e18. The
//                  unit ClearingVerifier.evaluateVolume compares limits in.
//   unit price     USD per smallest unit, times 1e18. The unit Solution.prices
//                  carries and verify checks the band and uniform price in.
// The quote token's unit price is its oracle price, so the base token's unit
// price is p times that, floored. Every execution is then derived from the two
// unit prices, never from p, so the uniform price check holds by construction.

import type {Address} from "viem";
import {WAD, limitRespected, uniformPriceHolds, withinBand} from "./math.ts";
import {PARTIAL_FILL, type Intent, type VenueCall} from "./solution.ts";

export interface BookEntry {
  /** Position in Solution.intents, which is what an Execution points at. */
  index: number;
  intent: Intent;
}

export interface Pair {
  base: Address;
  quote: Address;
  entries: BookEntry[];
}

export interface Reference {
  /** Oracle unit prices, read the way Settlement._verify derives them. */
  quotePrice: bigint;
  basePrice: bigint;
  /** SessionManager.maxDeviationBps for the batch's session. */
  maxDeviationBps: bigint;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Splits intents into base/quote pairs. An intent between two base tokens has no
 * pair here. The contract could settle it, but this solver clears per pair and
 * leaves multi hop matching for later, desain-kliring.md section 8.
 */
export function pairsOf(intents: readonly Intent[], quote: Address): {pairs: Pair[]; unsupported: number[]} {
  const byBase = new Map<string, Pair>();
  const unsupported: number[] = [];
  intents.forEach((intent, index) => {
    const sellsQuote = same(intent.sellToken, quote);
    const buysQuote = same(intent.buyToken, quote);
    if (sellsQuote === buysQuote) {
      unsupported.push(index);
      return;
    }
    const base = sellsQuote ? intent.buyToken : intent.sellToken;
    const pair = byBase.get(base.toLowerCase()) ?? {base, quote, entries: []};
    pair.entries.push({index, intent});
    byBase.set(base.toLowerCase(), pair);
  });
  const pairs = [...byBase.values()].sort((a, b) => (BigInt(a.base) < BigInt(b.base) ? -1 : 1));
  return {pairs, unsupported};
}

export function baseUnitPrice(p: bigint, ref: Reference): bigint {
  return (p * ref.quotePrice) / WAD;
}

/**
 * Whether the pair price passes ClearingVerifier._checkBand. The quote token is
 * priced at its own oracle price, so only the base token can leave the band.
 */
export function inBand(p: bigint, ref: Reference): boolean {
  return withinBand(baseUnitPrice(p, ref), ref.basePrice, ref.maxDeviationBps);
}

export function referencePairPrice(ref: Reference): bigint {
  return (ref.basePrice * WAD) / ref.quotePrice;
}

/** The lowest and highest pair price inside the band, found exactly rather than estimated. */
export function bandEdges(ref: Reference): {lo: bigint; hi: bigint} | null {
  const slack = (ref.basePrice * ref.maxDeviationBps) / 10_000n;
  const uLo = ref.basePrice - slack;
  const uHi = ref.basePrice + slack;
  let lo = (uLo * WAD + ref.quotePrice - 1n) / ref.quotePrice;
  let hi = ((uHi + 1n) * WAD - 1n) / ref.quotePrice;
  // The closed forms above are exact, and these loops only prove it. Each runs
  // at most a couple of steps, so a wrong edge shows up as a refused band.
  for (let n = 0; n < 4 && lo > 0n && inBand(lo - 1n, ref); n += 1) lo -= 1n;
  for (let n = 0; n < 4 && !inBand(lo, ref); n += 1) lo += 1n;
  for (let n = 0; n < 4 && inBand(hi + 1n, ref); n += 1) hi += 1n;
  for (let n = 0; n < 4 && !inBand(hi, ref); n += 1) hi -= 1n;
  if (lo > hi || !inBand(lo, ref) || !inBand(hi, ref)) return null;
  return {lo, hi};
}

export interface PackedLeg {
  sellsQuote: boolean;
  sellAmount: bigint;
  minBuyAmount: bigint;
}

export interface Volume {
  demand: bigint;
  supply: bigint;
  executable: bigint;
}

/** ClearingVerifier.evaluateVolume, comparison for comparison. */
export function volumeAt(legs: readonly PackedLeg[], price: bigint): Volume {
  let demand = 0n;
  let supply = 0n;
  for (const l of legs) {
    if (l.sellsQuote) {
      if (l.sellAmount * WAD >= l.minBuyAmount * price) demand += l.minBuyAmount;
    } else if (l.minBuyAmount * WAD <= l.sellAmount * price) {
      supply += l.sellAmount;
    }
  }
  return {demand, supply, executable: demand < supply ? demand : supply};
}

export function legsOf(pair: Pair): PackedLeg[] {
  return pair.entries.map(({intent}) => ({
    sellsQuote: same(intent.sellToken, pair.quote),
    sellAmount: intent.sellAmount,
    minBuyAmount: intent.minBuyAmount,
  }));
}

export interface Clearing extends Volume {
  price: bigint;
  imbalance: bigint;
}

const abs = (x: bigint) => (x < 0n ? -x : x);

/**
 * F16. The price that maximises executable volume, then minimises imbalance,
 * then sits closest to the reference, desain-kliring.md section 2. A final tie
 * takes the lower price so the answer never depends on iteration order.
 *
 * Candidates are every limit price (Lemma 2), the reference and the two band
 * edges, kept only when inside the band. The limits are taken the way the
 * integer comparison in evaluateVolume draws them. A buyer accepts every price up
 * to the floor of S*1e18/B and a seller every price from the ceiling of
 * B*1e18/S, so volume only changes at those points. The edges are there because
 * the band can cut an interval that no limit and not the reference falls in.
 */
export function clear(pair: Pair, ref: Reference): Clearing | null {
  const edges = bandEdges(ref);
  if (!edges) return null;
  const legs = legsOf(pair);
  const candidates = new Set<bigint>([referencePairPrice(ref), edges.lo, edges.hi]);
  for (const l of legs) {
    if (l.sellsQuote) {
      if (l.minBuyAmount > 0n) candidates.add((l.sellAmount * WAD) / l.minBuyAmount);
    } else if (l.sellAmount > 0n) {
      candidates.add((l.minBuyAmount * WAD + l.sellAmount - 1n) / l.sellAmount);
    }
  }

  const pRef = referencePairPrice(ref);
  let best: Clearing | null = null;
  for (const price of candidates) {
    if (price <= 0n || price < edges.lo || price > edges.hi || !inBand(price, ref)) continue;
    const v = volumeAt(legs, price);
    const c: Clearing = {...v, price, imbalance: abs(v.demand - v.supply)};
    if (!best || better(c, best, pRef)) best = c;
  }
  return best;
}

function better(a: Clearing, b: Clearing, pRef: bigint): boolean {
  if (a.executable !== b.executable) return a.executable > b.executable;
  if (a.imbalance !== b.imbalance) return a.imbalance < b.imbalance;
  const da = abs(a.price - pRef);
  const db = abs(b.price - pRef);
  if (da !== db) return da < db;
  return a.price < b.price;
}
