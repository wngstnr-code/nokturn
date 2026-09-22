// F15. What the venue would have given, read from the deployed adapter.
//
// quoteFromState through eth_call, at a pinned block, on the adapter Settlement
// itself names as baselineAdapter. The contract checks the baseline floor with
// that very call, so any other path, a local port of the tick math or the
// Quoter, would be a second definition that could disagree with the one that
// decides. docs/desain-baseline.md.

import type {Address, PublicClient} from "viem";
import {adapterAbi} from "./abi.ts";
import {revertName} from "./chain.ts";
import {tokenIndex, type Solution} from "./solution.ts";

export type Quote = {ok: true; out: bigint} | {ok: false; error: string};

export async function quote(c: PublicClient, adapter: Address, tokenIn: Address, tokenOut: Address, amount: bigint, blockNumber: bigint): Promise<Quote> {
  try {
    const out = (await c.readContract({address: adapter, abi: adapterAbi(), functionName: "quoteFromState", args: [tokenIn, tokenOut, amount], blockNumber})) as bigint;
    return {ok: true, out};
  } catch (error) {
    const name = revertName(error);
    if (name === null) throw error;
    return {ok: false, error: name};
  }
}

export interface FloorCheck {
  /** false when some direction could not be quoted, which makes Settlement score the batch zero. */
  priced: boolean;
  /** Directions where the baselines claimed sum below the venue, each a BaselineBelowVenue revert. */
  belowVenue: {tokenIn: Address; tokenOut: Address; claimed: bigint; floor: bigint}[];
  unquoted: {tokenIn: Address; tokenOut: Address; error: string}[];
}

/**
 * Settlement._baselineFloor. One quote per pair direction on that direction's
 * gross executed sell, compared with the sum of the baselines claimed for it.
 */
export async function checkBaselineFloor(c: PublicClient, adapter: Address, s: Solution, blockNumber: bigint): Promise<FloorCheck> {
  const out: FloorCheck = {priced: true, belowVenue: [], unquoted: []};
  if (BigInt(adapter) === 0n) return {...out, priced: false};

  const n = s.tokens.length;
  const sold = Array.from({length: n}, () => Array<bigint>(n).fill(0n));
  const claimed = Array.from({length: n}, () => Array<bigint>(n).fill(0n));
  s.executions.forEach((e, k) => {
    const i = s.intents[Number(e.intentIndex)]!;
    const si = tokenIndex(s.tokens, i.sellToken);
    const bi = tokenIndex(s.tokens, i.buyToken);
    sold[si]![bi]! += e.executedSell;
    claimed[si]![bi]! += s.baselineQuotes[k]!;
  });

  for (let si = 0; si < n; si += 1) {
    for (let bi = 0; bi < n; bi += 1) {
      if (sold[si]![bi] === 0n) continue;
      const tokenIn = s.tokens[si]!;
      const tokenOut = s.tokens[bi]!;
      const q = await quote(c, adapter, tokenIn, tokenOut, sold[si]![bi]!, blockNumber);
      if (!q.ok) {
        out.priced = false;
        out.unquoted.push({tokenIn, tokenOut, error: q.error});
      } else if (claimed[si]![bi]! < q.out) {
        out.belowVenue.push({tokenIn, tokenOut, claimed: claimed[si]![bi]!, floor: q.out});
      }
    }
  }
  return out;
}
