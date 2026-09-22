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

export interface Fill {
  index: number;
  executedSell: bigint;
  executedBuy: bigint;
}

export interface Allocation {
  price: bigint;
  quotePrice: bigint;
  basePrice: bigint;
  fills: Fill[];
  excluded: {index: number; reason: string}[];
}

interface Candidate {
  entry: BookEntry;
  buys: boolean;
  /** Base units this intent would trade if filled completely at the price. */
  size: bigint;
  partial: boolean;
  /** Strictly better than the clearing price, rather than exactly at it. */
  better: boolean;
}

/**
 * F17. Fills at one clearing price. The short side fills completely and the long
 * side is rationed to it, plus venueBase when a venue will take or supply the
 * rest (zero means a pure cross).
 *
 * Rationing follows desain-kliring.md section 5. Intents strictly better than
 * the price go before intents exactly at it, and inside a tier the share is pro
 * rata, never by arrival, because arrival order is what a batch exists to make
 * worthless. An intent without PARTIAL_FILL is filled completely or left out.
 * Those are taken smallest first up to the tier's pro rata share for them as a
 * group, so the rule is deterministic without being a time priority.
 *
 * Everything is counted in base units. A buyer rationed to a base units pays the
 * ceiling of what they cost, and receives exactly a. Every amount a user
 * receives is floored and every amount pulled is rounded towards the contract,
 * which is what keeps both tokens conserved at once.
 *
 * A fill that the verifier would refuse (a limit broken by that rounding, or a
 * sliver too small for the 3 bps uniform price tolerance) takes its intent out,
 * and the allocation is redone without it. Each pass removes one intent, so the
 * loop ends.
 */
export function allocate(pair: Pair, clearing: Clearing, ref: Reference, venueBase = 0n): Allocation {
  const quotePrice = ref.quotePrice;
  const basePrice = baseUnitPrice(clearing.price, ref);
  const excluded: Allocation["excluded"] = [];
  const out: Allocation = {price: clearing.price, quotePrice, basePrice, fills: [], excluded};
  if (basePrice === 0n) {
    for (const e of pair.entries) excluded.push({index: e.index, reason: "base unit price floors to zero"});
    return out;
  }

  let live: Candidate[] = [];
  for (const entry of pair.entries) {
    const i = entry.intent;
    const buys = same(i.sellToken, pair.quote);
    const lhs = buys ? i.sellAmount * WAD : i.minBuyAmount * WAD;
    const rhs = buys ? i.minBuyAmount * clearing.price : i.sellAmount * clearing.price;
    const accepts = buys ? lhs >= rhs : lhs <= rhs;
    if (!accepts) {
      excluded.push({index: entry.index, reason: "limit is on the wrong side of the clearing price"});
      continue;
    }
    const size = buys ? (i.sellAmount * quotePrice) / basePrice : i.sellAmount;
    if (size === 0n) {
      excluded.push({index: entry.index, reason: "buys nothing at the clearing price"});
      continue;
    }
    live.push({entry, buys, size, partial: (i.flags & PARTIAL_FILL) !== 0, better: lhs !== rhs});
  }

  for (let pass = 0; pass <= pair.entries.length; pass += 1) {
    const fills = fillsFor(live, quotePrice, basePrice, venueBase);
    const bad = fills.find((f) => f.reason !== null);
    if (!bad) {
      out.fills = fills.filter((f) => f.fill.executedSell > 0n).map((f) => f.fill);
      return out;
    }
    excluded.push({index: bad.fill.index, reason: bad.reason!});
    live = live.filter((c) => c.entry.index !== bad.fill.index);
  }
  throw new Error("allocation did not settle, which the pass bound makes impossible");
}

function fillsFor(live: Candidate[], quotePrice: bigint, basePrice: bigint, venueBase: bigint): {fill: Fill; reason: string | null}[] {
  const buyers = live.filter((c) => c.buys);
  const sellers = live.filter((c) => !c.buys);
  const demand = sum(buyers.map((c) => c.size));
  const supply = sum(sellers.map((c) => c.size));

  const allot = new Map<number, bigint>();
  if (demand > supply) {
    for (const c of sellers) allot.set(c.entry.index, c.size);
    ration(buyers, supply + venueBase, allot);
  } else {
    for (const c of buyers) allot.set(c.entry.index, c.size);
    ration(sellers, demand + venueBase, allot);
  }

  return live.map((c) => {
    const i = c.entry.intent;
    const a = allot.get(c.entry.index) ?? 0n;
    let executedSell: bigint;
    let executedBuy: bigint;
    if (a === 0n) {
      executedSell = 0n;
      executedBuy = 0n;
    } else if (c.buys) {
      executedSell = a === c.size ? i.sellAmount : (a * basePrice + quotePrice - 1n) / quotePrice;
      executedBuy = a;
    } else {
      executedSell = a;
      executedBuy = (a * basePrice) / quotePrice;
    }
    const fill = {index: c.entry.index, executedSell, executedBuy};
    return {fill, reason: a === 0n ? null : refusal(i, fill, c.buys, quotePrice, basePrice)};
  });
}

/** What ClearingVerifier.verify would revert on for this one fill, or null. */
function refusal(i: Intent, f: Fill, buys: boolean, quotePrice: bigint, basePrice: bigint): string | null {
  if (f.executedSell > i.sellAmount) return "OverfilledIntent";
  if (f.executedSell !== i.sellAmount && (i.flags & PARTIAL_FILL) === 0) return "PartialFillNotAllowed";
  if (f.executedBuy === 0n) return "receives nothing after rounding";
  if (!limitRespected(f.executedBuy, i.sellAmount, i.minBuyAmount, f.executedSell)) return "LimitViolated after rounding";
  const [sellPrice, buyPrice] = buys ? [quotePrice, basePrice] : [basePrice, quotePrice];
  if (!uniformPriceHolds(f.executedSell, f.executedBuy, sellPrice, buyPrice)) return "NonUniformPrice, too small for the 3 bps tolerance";
  return null;
}

function ration(side: Candidate[], capacity: bigint, allot: Map<number, bigint>): void {
  let remaining = capacity;
  for (const tier of [side.filter((c) => c.better), side.filter((c) => !c.better)]) {
    const total = sum(tier.map((c) => c.size));
    if (total <= remaining) {
      for (const c of tier) allot.set(c.entry.index, c.size);
      remaining -= total;
      continue;
    }
    const cap = remaining;
    const whole = tier.filter((c) => !c.partial).sort((a, b) => (a.size === b.size ? a.entry.index - b.entry.index : a.size < b.size ? -1 : 1));
    const split = tier.filter((c) => c.partial);
    const wholeShare = (cap * sum(whole.map((c) => c.size))) / total;

    let used = 0n;
    for (const c of whole) {
      const take = used + c.size <= wholeShare ? c.size : 0n;
      allot.set(c.entry.index, take);
      used += take;
    }
    const rest = cap - used;
    const splitTotal = sum(split.map((c) => c.size));
    for (const c of split) {
      const share = splitTotal === 0n ? 0n : (c.size * rest) / splitTotal;
      const take = share < c.size ? share : c.size;
      allot.set(c.entry.index, take);
      used += take;
    }
    remaining = cap - used;
  }
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
