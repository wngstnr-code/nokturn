// F19. From signed intents and one block of chain state to a Solution.
//
// Per pair, the clearing in clearing.ts is tried first. It is kept only when
// every fill beats the venue on its own and the venue can return what the
// residual needs. Otherwise the pair goes whole to the venue the way
// ForkDemo._buildRouted does it, which saves nothing and is the honest answer
// when there is nothing to net. contracts/script/demo/ForkDemo.s.sol is the
// reference both paths are held to.

import {erc20Abi, type Address, type Hex, type PublicClient} from "viem";
import {oracleAbi, sessionAbi} from "./abi.ts";
import {quote} from "./baseline.ts";
import type {Contracts} from "./chain.ts";
import {allocate, clear, pairsOf, route, type Fill, type Pair, type Reference} from "./clearing.ts";
import {WAD, claimedSavings, limitRespected, uniformPriceHolds, withinBand} from "./math.ts";
import {orderTokens, type Execution, type Intent, type Solution, type VenueCall} from "./solution.ts";

export interface SignedIntent {
  intent: Intent;
  signature: Hex;
}

export interface OracleRow {
  /** Settlement._verify's figure, refPrice * 1e18 / 10^decimals. */
  price: bigint;
  healthy: boolean;
}

export interface Inputs {
  block: bigint;
  session: number;
  maxDeviationBps: bigint;
  oracle: Map<string, OracleRow | {error: string}>;
}

const key = (a: string) => a.toLowerCase();
const same = (a: string, b: string) => key(a) === key(b);

/** Reads what Settlement._verify reads, for every token the intents touch, at one block. */
export async function readInputs(c: PublicClient, k: Contracts, batchId: bigint, tokens: readonly Address[], block: bigint): Promise<Inputs> {
  const session = Number(await c.readContract({address: k.sessions, abi: sessionAbi(), functionName: "sessionAt", args: [batchId], blockNumber: block}));
  const maxDeviationBps = BigInt((await c.readContract({address: k.sessions, abi: sessionAbi(), functionName: "maxDeviationBps", args: [session], blockNumber: block})) as number);
  const oracle = new Map<string, OracleRow | {error: string}>();
  for (const token of tokens) {
    try {
      const [price, , healthy] = (await c.readContract({address: k.oracle, abi: oracleAbi(), functionName: "refPrice", args: [token], blockNumber: block})) as [bigint, bigint, boolean];
      const decimals = await c.readContract({address: token, abi: erc20Abi, functionName: "decimals", blockNumber: block});
      oracle.set(key(token), {price: (price * WAD) / 10n ** BigInt(decimals), healthy});
    } catch (error) {
      oracle.set(key(token), {error: (error as Error).message.split("\n")[0]!});
    }
  }
  return {block, session, maxDeviationBps, oracle};
}

export interface PairOutcome {
  base: Address;
  mode: "netted" | "routed" | "skipped";
  reason?: string;
  fills: Fill[];
  baselines: Map<number, bigint>;
  basePrice: bigint;
  venueCalls: VenueCall[];
}

export interface Plan {
  solution: Solution;
  pairs: PairOutcome[];
  unsupported: number[];
}

function oracleOf(inputs: Inputs, token: Address): OracleRow | null {
  const row = inputs.oracle.get(key(token));
  if (!row || "error" in row || !row.healthy) return null;
  return row;
}

export async function solve(c: PublicClient, k: Contracts, batchId: bigint, signed: readonly SignedIntent[], quoteToken: Address, solver: Address, inputs: Inputs): Promise<Plan> {
  const intents = signed.map((s) => s.intent);
  const {pairs, unsupported} = pairsOf(intents, quoteToken);
  const outcomes: PairOutcome[] = [];

  for (const pair of pairs) {
    const q = oracleOf(inputs, pair.quote);
    const b = oracleOf(inputs, pair.base);
    if (!q || !b) {
      outcomes.push(skipped(pair, "a token in the pair has no healthy oracle price, Settlement would revert OracleUnhealthy"));
      continue;
    }
    const ref: Reference = {quotePrice: q.price, basePrice: b.price, maxDeviationBps: inputs.maxDeviationBps};
    const netted = await tryNetted(c, k, pair, ref, inputs.block);
    if (netted.mode === "netted") {
      outcomes.push(netted);
      continue;
    }
    const routed = await tryRouted(c, k, pair, ref, inputs.block);
    outcomes.push(routed.mode === "routed" ? routed : {...routed, reason: `${netted.reason}, and routing failed too: ${routed.reason}`});
  }

  return {solution: assemble(batchId, signed, quoteToken, solver, inputs, outcomes), pairs: outcomes, unsupported};
}

function skipped(pair: Pair, reason: string): PairOutcome {
  return {base: pair.base, mode: "skipped", reason, fills: [], baselines: new Map(), basePrice: 0n, venueCalls: []};
}

async function tryNetted(c: PublicClient, k: Contracts, pair: Pair, ref: Reference, block: bigint): Promise<PairOutcome> {
  const clearing = clear(pair, ref);
  if (!clearing || clearing.executable === 0n) return skipped(pair, "no price in the band crosses the two sides");
  const a = allocate(pair, clearing, ref);
  if (a.fills.length === 0) return skipped(pair, "the crossing leaves no fill the verifier would take");

  const byIndex = new Map(pair.entries.map((e) => [e.index, e.intent]));
  const baselines = new Map<number, bigint>();
  for (const f of a.fills) {
    const i = byIndex.get(f.index)!;
    const venue = await quote(c, k.baselineAdapter, i.sellToken, i.buyToken, f.executedSell, block);
    if (!venue.ok) return skipped(pair, `the venue cannot quote intent ${f.index}: ${venue.error}`);
    if (f.executedBuy < venue.out) return skipped(pair, `intent ${f.index} would get less than the venue gives, WorseThanBaseline`);
    baselines.set(f.index, venue.out);
  }

  let quoteError: string | null = null;
  let routed: VenueCall[];
  try {
    routed = (
      await routeAsync(pair, a.fills, k.baselineAdapter, async (need) => {
        const venue = await quote(c, k.baselineAdapter, need.tokenIn, need.tokenOut, need.amountIn, block);
        if (!venue.ok) {
          quoteError = venue.error;
          return 0n;
        }
        return venue.out;
      })
    ).venueCalls;
  } catch (error) {
    return skipped(pair, quoteError ?? (error as Error).message);
  }
  return {base: pair.base, mode: "netted", fills: a.fills, baselines, basePrice: a.basePrice, venueCalls: routed};
}

/** route() with an asynchronous minOut, resolved before the synchronous check runs. */
async function routeAsync(pair: Pair, fills: readonly Fill[], adapter: Address, minOut: (need: {tokenIn: Address; tokenOut: Address; amountIn: bigint; needOut: bigint}) => Promise<bigint>) {
  const probe = route(pair, fills, adapter, (need) => need.needOut);
  if (probe.venueCalls.length === 0) return probe;
  const call = probe.venueCalls[0]!;
  const resolved = await minOut({tokenIn: call.tokenIn, tokenOut: call.tokenOut, amountIn: call.amountIn, needOut: call.minOut});
  return route(pair, fills, adapter, () => resolved);
}

/**
 * ForkDemo._buildRouted, for one direction of one pair. Every intent on the
 * larger side goes to the venue in one call and receives its pro rata share of
 * what came back, the last one taking the remainder so nothing is withheld. A
 * batch that saves nothing may withhold nothing, because the fee cap is a share
 * of the surplus and a share of zero is zero.
 */
async function tryRouted(c: PublicClient, k: Contracts, pair: Pair, ref: Reference, block: bigint): Promise<PairOutcome> {
  const buys = pair.entries.filter((e) => same(e.intent.sellToken, pair.quote));
  const sells = pair.entries.filter((e) => !same(e.intent.sellToken, pair.quote));
  const usd = (list: typeof buys, price: bigint) => list.reduce((s, e) => s + (e.intent.sellAmount * price) / WAD, 0n);
  let side = usd(buys, ref.quotePrice) >= usd(sells, ref.basePrice) ? buys : sells;
  if (side.length === 0) return skipped(pair, "nothing to route");
  const buying = side === buys;
  const tokenIn = buying ? pair.quote : pair.base;
  const tokenOut = buying ? pair.base : pair.quote;

  for (let pass = 0; pass <= pair.entries.length && side.length > 0; pass += 1) {
    const total = side.reduce((s, e) => s + e.intent.sellAmount, 0n);
    const venue = await quote(c, k.baselineAdapter, tokenIn, tokenOut, total, block);
    if (!venue.ok) return skipped(pair, `the venue cannot quote the routed volume: ${venue.error}`);

    const fills: Fill[] = [];
    let given = 0n;
    side.forEach((e, n) => {
      const executedBuy = n === side.length - 1 ? venue.out - given : (venue.out * e.intent.sellAmount) / total;
      given += executedBuy;
      fills.push({index: e.index, executedSell: e.intent.sellAmount, executedBuy});
    });

    const broken = fills.find((f) => {
      const i = side.find((e) => e.index === f.index)!.intent;
      return f.executedBuy === 0n || !limitRespected(f.executedBuy, i.sellAmount, i.minBuyAmount, f.executedSell);
    });
    if (broken) {
      side = side.filter((e) => e.index !== broken.index);
      continue;
    }

    // The worse of the prices the split implies, so every fill passes the
    // uniform price check. ForkDemo takes the minimum for the same reason.
    const implied = fills.map((f) =>
      buying ? (f.executedSell * ref.quotePrice) / f.executedBuy : (f.executedBuy * ref.quotePrice + f.executedSell - 1n) / f.executedSell,
    );
    const basePrice = buying ? implied.reduce((a, b) => (a < b ? a : b)) : implied.reduce((a, b) => (a > b ? a : b));
    if (!withinBand(basePrice, ref.basePrice, ref.maxDeviationBps)) return skipped(pair, "the venue price is outside the session band, PriceOutsideBand");
    for (const f of fills) {
      const [sp, bp] = buying ? [ref.quotePrice, basePrice] : [basePrice, ref.quotePrice];
      if (!uniformPriceHolds(f.executedSell, f.executedBuy, sp, bp)) return skipped(pair, `intent ${f.index} breaks the uniform price at the venue price, NonUniformPrice`);
    }

    const baselines = new Map(fills.map((f) => [f.index, f.executedBuy]));
    const venueCalls: VenueCall[] = [{adapter: k.baselineAdapter, tokenIn, tokenOut, amountIn: total, minOut: venue.out}];
    return {base: pair.base, mode: "routed", fills, baselines, basePrice, venueCalls};
  }
  return skipped(pair, "every intent's limit is above what the venue gives");
}

function assemble(batchId: bigint, signed: readonly SignedIntent[], quoteToken: Address, solver: Address, inputs: Inputs, outcomes: PairOutcome[]): Solution {
  const used = outcomes.flatMap((o) => o.fills).sort((a, b) => a.index - b.index);
  const position = new Map(used.map((f, n) => [f.index, n]));
  const intents = used.map((f) => signed[f.index]!.intent);
  const signatures = used.map((f) => signed[f.index]!.signature);

  const tokens = intents.length ? orderTokens(intents, quoteToken) : [];
  const basePrice = new Map(outcomes.filter((o) => o.mode !== "skipped").map((o) => [key(o.base), o.basePrice]));
  const prices = tokens.map((t) => (same(t, quoteToken) ? (inputs.oracle.get(key(t)) as OracleRow).price : basePrice.get(key(t))!));

  const executions: Execution[] = used.map((f) => ({intentIndex: BigInt(position.get(f.index)!), executedSell: f.executedSell, executedBuy: f.executedBuy}));
  const baselineByIndex = new Map(outcomes.flatMap((o) => [...o.baselines.entries()]));
  const baselineQuotes = used.map((f) => baselineByIndex.get(f.index)!);
  const venueCalls = outcomes.flatMap((o) => o.venueCalls);

  return {
    batchId,
    intents,
    signatures,
    tokens,
    prices,
    executions,
    venueCalls,
    baselineQuotes,
    claimedSavings: intents.length ? claimedSavings(executions, baselineQuotes, prices, intents, tokens) : 0n,
    solver,
  };
}
