// Building a submitCross for AuctionHouse. The rules are read from
// contracts/src/AuctionHouse.sol, _applyCross, _match and _effectiveLimit, and
// mirrored here in integers so the keeper can check a cross before sending it.
//
// Why the price is not simply the one indicative() names. That search only
// tries the book's own limit prices and the reference. When the buyers want
// more than the sellers hold at that price, the sellers fill in full and the
// buyers must receive within one unit per fill of the sellers' tokens, but a
// buyer's tokens move in steps of 1e18 / price, which for a 6 decimal quote
// and an 18 decimal token is billions of units. So that side is almost never
// constructible. Raising the price to the smallest one where demand no longer
// exceeds supply makes the buyers the short side, and then every fill is exact.
// The contract accepts any price inside the collar that respects each fill's
// limit, so this is a cross it is designed to take.

const WAD = 10n ** 18n;
const BPS = 10_000n;

/** IntentKind in contracts/src/types/Types.sol. */
export const KIND = {SPOT: 0, MOO: 1, LOO: 2, ROO: 3} as const;

export interface BookEntry {
  /** Position in the auction's book, which is what Execution.intentIndex names. */
  index: number;
  owner: string;
  buy: boolean;
  escrowed: boolean;
  cancelled: boolean;
  kind: number;
  maxDevFromRefBps: number;
  sellAmount: bigint;
  limitPrice: bigint;
  filledSell: bigint;
}

export interface Execution {
  intentIndex: bigint;
  executedSell: bigint;
  executedBuy: bigint;
}

export const quoteOf = (tokenAmount: bigint, price: bigint) => (tokenAmount * price) / WAD;
export const tokenOf = (quoteAmount: bigint, price: bigint) => (quoteAmount * WAD) / price;

export function collar(ref: bigint, collarBps: number): {low: bigint; high: bigint} {
  return {low: (ref * (BPS - BigInt(collarBps))) / BPS, high: (ref * (BPS + BigInt(collarBps))) / BPS};
}

export function effectiveLimit(c: BookEntry, ref: bigint, rooExcluded: boolean): {limit: bigint; participating: boolean} {
  if (c.kind === KIND.MOO) return {limit: 0n, participating: true};
  if (c.kind === KIND.LOO) return {limit: c.limitPrice, participating: true};
  if (rooExcluded || ref === 0n) return {limit: 0n, participating: false};
  const dev = BigInt(c.maxDevFromRefBps);
  return {limit: c.buy ? (ref * (BPS + dev)) / BPS : (ref * (BPS - dev)) / BPS, participating: true};
}

/** Who takes part at this price, with the same predicate _match uses. Frozen book only. */
function inAt(c: BookEntry, price: bigint, ref: bigint, rooExcluded: boolean): boolean {
  if (c.cancelled || !c.escrowed) return false;
  const {limit, participating} = effectiveLimit(c, ref, rooExcluded);
  if (!participating) return false;
  if (c.buy) return limit === 0n || price <= limit;
  return limit === 0n || price >= limit;
}

/** _match. Demand and supply in token units, so demand floors per intent. */
export function match(book: BookEntry[], price: bigint, ref: bigint, rooExcluded: boolean): {demand: bigint; supply: bigint; matched: bigint} {
  if (price === 0n) return {demand: 0n, supply: 0n, matched: 0n};
  let demand = 0n;
  let supply = 0n;
  for (const c of book) {
    if (!inAt(c, price, ref, rooExcluded)) continue;
    if (c.buy) demand += tokenOf(c.sellAmount, price);
    else supply += c.sellAmount;
  }
  return {demand, supply, matched: demand < supply ? demand : supply};
}

/**
 * The smallest price in [from, to] where demand no longer exceeds supply, or
 * null. Demand only falls as the price rises and supply only grows, so their
 * difference is monotone and a binary search over integers finds it.
 */
export function balancingPrice(book: BookEntry[], from: bigint, to: bigint, ref: bigint, rooExcluded: boolean): bigint | null {
  const short = (p: bigint) => {
    const m = match(book, p, ref, rooExcluded);
    return m.demand <= m.supply;
  };
  if (from > to || !short(to)) return null;
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (short(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

export type CrossPlan =
  | {ok: true; price: bigint; matched: bigint; executions: Execution[]}
  | {ok: false; reason: string};

/**
 * Buyers fill in full. Sellers deliver exactly the tokens the buyers receive,
 * split pro rata by largest remainder so no seller gives more than it escrowed.
 * Conservation then holds by construction, see the comment on each step.
 */
export function planCross(book: BookEntry[], ref: bigint, collarBps: number, rooExcluded: boolean, preferred: bigint): CrossPlan {
  const {low, high} = collar(ref, collarBps);
  const start = preferred < low ? low : preferred;
  if (start > high) return {ok: false, reason: `preferred price ${preferred} is above the collar high ${high}`};
  const price = balancingPrice(book, start, high, ref, rooExcluded);
  if (price === null) return {ok: false, reason: `demand exceeds supply at every price up to the collar high ${high}`};

  const buys = book.filter((c) => c.buy && inAt(c, price, ref, rooExcluded) && tokenOf(c.sellAmount - c.filledSell, price) > 0n);
  const sells = book.filter((c) => !c.buy && inAt(c, price, ref, rooExcluded) && c.sellAmount - c.filledSell > 0n);
  const target = buys.reduce((sum, c) => sum + tokenOf(c.sellAmount - c.filledSell, price), 0n);
  if (target === 0n) return {ok: false, reason: `nothing matches at ${price}`};
  const available = sells.reduce((sum, c) => sum + (c.sellAmount - c.filledSell), 0n);
  if (available < target) return {ok: false, reason: `sellers hold ${available} and buyers take ${target} at ${price}`};

  // Largest remainder. Floors first, then one unit each to the largest
  // remainders until the total is exactly the buyers' tokens.
  const shares = sells.map((c) => {
    const remaining = c.sellAmount - c.filledSell;
    const exact = remaining * target;
    return {c, remaining, x: exact / available, rem: exact % available};
  });
  let left = target - shares.reduce((sum, s) => sum + s.x, 0n);
  for (const s of [...shares].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.c.index - b.c.index))) {
    if (left === 0n) break;
    if (s.x < s.remaining) {
      s.x += 1n;
      left -= 1n;
    }
  }
  if (left !== 0n) return {ok: false, reason: `could not place ${left} units across the sellers`};

  const executions: Execution[] = [];
  for (const c of buys) {
    const sell = c.sellAmount - c.filledSell;
    executions.push({intentIndex: BigInt(c.index), executedSell: sell, executedBuy: tokenOf(sell, price)});
  }
  for (const s of shares) {
    if (s.x === 0n) continue;
    executions.push({intentIndex: BigInt(s.c.index), executedSell: s.x, executedBuy: quoteOf(s.x, price)});
  }
  executions.sort((a, b) => (a.intentIndex < b.intentIndex ? -1 : 1));

  const problem = checkCross(book, ref, rooExcluded, price, executions);
  if (problem) return {ok: false, reason: problem};
  return {ok: true, price, matched: match(book, price, ref, rooExcluded).matched, executions};
}

/**
 * _applyCross, returning the name of the error it would revert with, or null.
 * Run on every plan before it is sent, because a cross that reverts on chain
 * still costs gas and a bond approval.
 */
export function checkCross(book: BookEntry[], ref: bigint, rooExcluded: boolean, price: bigint, e: Execution[]): string | null {
  let tokenIn = 0n;
  let tokenOut = 0n;
  let quoteIn = 0n;
  let quoteOut = 0n;
  let last = -1n;
  for (const [k, x] of e.entries()) {
    if (x.intentIndex <= last) return `ExecutionsNotAscending(${k})`;
    last = x.intentIndex;
    const c = book[Number(x.intentIndex)];
    if (!c || !c.escrowed || c.cancelled) return `CommitmentNotEscrowed(${k})`;
    const {limit, participating} = effectiveLimit(c, ref, rooExcluded);
    if (!participating) return `LimitNotRespected(${k}, 0, ${price})`;
    if (c.buy && limit !== 0n && price > limit) return `LimitNotRespected(${k}, ${limit}, ${price})`;
    if (!c.buy && limit !== 0n && price < limit) return `LimitNotRespected(${k}, ${limit}, ${price})`;
    if (x.executedSell > c.sellAmount - c.filledSell) return `FillExceedsEscrow(${k})`;
    const expected = c.buy ? tokenOf(x.executedSell, price) : quoteOf(x.executedSell, price);
    if (x.executedBuy !== expected) return `UniformPriceViolated(${k}, ${expected}, ${x.executedBuy})`;
    if (c.buy) {
      quoteIn += x.executedSell;
      tokenOut += x.executedBuy;
    } else {
      tokenIn += x.executedSell;
      quoteOut += x.executedBuy;
    }
  }
  if (tokenIn < tokenOut) return `ValueNotConserved(${tokenIn}, ${tokenOut})`;
  if (quoteIn < quoteOut) return `ValueNotConserved(${quoteIn}, ${quoteOut})`;
  const {matched} = match(book, price, ref, rooExcluded);
  if (matched === 0n) return "NothingMatched";
  if (tokenOut + BigInt(e.length) < matched) return `VolumeBelowMatchable(${tokenOut}, ${matched})`;
  return null;
}

/** CivilDate.toYmd on the UTC date of a timestamp, which is how AuctionHouse keys an auction's day. */
export function ymdOf(timestamp: bigint): number {
  const d = new Date(Number(timestamp) * 1000);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}
