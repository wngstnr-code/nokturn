// The Solution a solver submits, its packed forms, and its hash.
//
// Types mirror contracts/src/types/Types.sol field for field. Packing mirrors
// Settlement._packIntents and _packExecutions byte for byte, because the solver
// calls ClearingVerifier.verify with its own packing and has to get the same
// answer Settlement would.

import {encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, type AbiFunction, type Address, type Hex} from "viem";
import {USDG} from "../../packages/shared/addresses.ts";
import {settlementAbi} from "./abi.ts";

export interface Intent {
  owner: Address;
  receiver: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  minBuyAmount: bigint;
  validAfter: number;
  validUntil: number;
  flags: number;
  kind: number;
  maxDevFromRefBps: number;
  allowedSessions: number;
  batchSpan: number;
  nonce: bigint;
}

export interface Execution {
  intentIndex: bigint;
  executedSell: bigint;
  executedBuy: bigint;
}

export interface VenueCall {
  adapter: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
}

export interface Solution {
  batchId: bigint;
  intents: Intent[];
  signatures: Hex[];
  tokens: Address[];
  prices: bigint[];
  executions: Execution[];
  venueCalls: VenueCall[];
  baselineQuotes: bigint[];
  claimedSavings: bigint;
  solver: Address;
}

/** IntentFlags in Types.sol. */
export const PARTIAL_FILL = 1;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Settlement._tokenIndex, which reverts TokenNotAllowed on a miss. */
export function tokenIndex(tokens: readonly Address[], token: Address): number {
  const i = tokens.findIndex((t) => same(t, token));
  if (i < 0) throw new Error(`token ${token} is not in the solution's token list`);
  return i;
}

/**
 * The quote asset at index 0, because ClearingVerifier.evaluateVolume prices
 * every pair against QUOTE_TOKEN_INDEX = 0. Everything else in ascending address
 * order, so the same intents always produce the same list and the same hash.
 */
export function orderTokens(intents: readonly Intent[], quote: Address = USDG): Address[] {
  const others = new Map<string, Address>();
  for (const i of intents) {
    for (const t of [i.sellToken, i.buyToken]) {
      if (!same(t, quote)) others.set(t.toLowerCase(), t);
    }
  }
  const rest = [...others.values()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return [quote, ...rest];
}

export function packIntents(intents: readonly Intent[], tokens: readonly Address[]): Hex {
  const parts = intents.map((i) =>
    encodePacked(
      ["uint16", "uint16", "uint8", "bytes3", "uint256", "uint256"],
      [tokenIndex(tokens, i.sellToken), tokenIndex(tokens, i.buyToken), i.flags, "0x000000", i.sellAmount, i.minBuyAmount],
    ),
  );
  return concat(parts);
}

export function packExecutions(executions: readonly Execution[]): Hex {
  const parts = executions.map((e) =>
    encodePacked(["uint32", "bytes4", "uint256", "uint256"], [Number(e.intentIndex), "0x00000000", e.executedSell, e.executedBuy]),
  );
  return concat(parts);
}

function concat(parts: Hex[]): Hex {
  return `0x${parts.map((p) => p.slice(2)).join("")}`;
}

function submitSolutionAbi(): AbiFunction {
  const item = settlementAbi().find((x) => x.type === "function" && x.name === "submitSolution");
  if (!item) throw new Error("Settlement ABI has no submitSolution");
  return item as AbiFunction;
}

export function encodeSolution(s: Solution): Hex {
  return encodeFunctionData({abi: [submitSolutionAbi()], functionName: "submitSolution", args: [s]});
}

/**
 * keccak256(abi.encode(s)), the hash submitSolution stores and finalize demands
 * again. A struct with dynamic members encodes as one tuple parameter, head
 * offset included, which is what abi.encode(s) produces.
 */
export function solutionHash(s: Solution): Hex {
  return keccak256(encodeAbiParameters(submitSolutionAbi().inputs, [s]));
}
