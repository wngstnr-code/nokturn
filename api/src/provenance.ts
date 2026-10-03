// Builds the Provenance and VerifiableCall that every published number carries.
//
// The rule from docs/rencana-uji.md section 11 is that a judge must be able to
// get the same number back without trusting us. A figure without a block and a
// way to recompute it does not belong in a response at all, so building these is
// not decoration, it is the thing that lets a number be published.

import {encodeFunctionData, type Abi, type Address} from "viem";
import type {Provenance, ProvenanceSource, VerifiableCall, Uint} from "../../packages/shared/api-types.ts";
import {chain} from "./chain.ts";
import {env} from "./config.ts";

export interface BlockStamp {
  number: bigint;
  timestamp: bigint;
}

/**
 * This chain's own block number and timestamp.
 *
 * Taken from eth_blockNumber, which is correct here. The ArbSys warning that
 * runs through this repo is about `block.number` read from inside a contract on
 * an Arbitrum chain, where it answers the parent chain's height. Over JSON-RPC
 * the node reports its own. ArbSys itself is not available on an anvil fork,
 * verified 20 September 2026, so there is nothing to cross check against there.
 */
export async function stamp(): Promise<BlockStamp> {
  const block = await chain().client.getBlock();
  return {number: block.number, timestamp: block.timestamp};
}

/**
 * For read only routes. The lifecycle reads the head on every poll on a real
 * chain, and a route that stamps soon after reuses that block rather than
 * spending a round trip that took close to two seconds on the official RPC on
 * 2 October 2026. It is a real block, and every read pinned to it answers for
 * that block, so the provenance stays exactly true. Anything that decides which
 * batch an intent joins keeps stamp(), because a head a second old is how D7
 * admitted intents into batches that had already closed. Never used on a fork,
 * where the poll reads no timestamp and an evm_revert can move the head back.
 */
export async function recentStamp(): Promise<BlockStamp> {
  if (seen && Date.now() - seen.at <= HEAD_REUSE_MS) return seen.head;
  return stamp();
}

const HEAD_REUSE_MS = 3_000;
let seen: {head: BlockStamp; at: number} | null = null;

export function sawHead(head: BlockStamp): void {
  seen = {head, at: Date.now()};
}

export function source(): ProvenanceSource {
  const c = chain();
  if (c.isFork) {
    return {
      kind: "fork",
      forkedFrom: c.chainId,
      pinnedBlock: String(c.pinned?.block ?? 0),
      pinnedAt: c.pinned?.timestamp ?? 0,
    };
  }
  if (c.isTestnet) {
    return {kind: "testnet", note: "tokens on this chain are test tokens"};
  }
  return {kind: "mainnet"};
}

export function provenance(at: BlockStamp, extra?: {transactionHash?: `0x${string}`; logIndex?: number}): Provenance {
  return {
    chainId: chain().chainId,
    blockNumber: String(at.number),
    blockTimestamp: Number(at.timestamp),
    ...extra,
    source: source(),
  };
}

/**
 * A call somebody else can run to get the same answer.
 *
 * The block is pinned into the command on purpose. Without it the reader runs
 * against head and gets a different number, then concludes we made ours up.
 */
export function verifiable(args: {
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  at: BlockStamp;
  expected: bigint | string;
  describes: string;
  signature: string;
  humanArgs: string[];
}): VerifiableCall {
  const data = encodeFunctionData({abi: args.abi, functionName: args.functionName, args: args.args});
  const quoted = args.humanArgs.map((a) => `"${a}"`).join(" ");
  const castCommand =
    `cast call ${args.to} "${args.signature}" ${quoted}`.trimEnd() +
    ` --block ${args.at.number} --rpc-url ${env.publicRpc}`;
  return {
    to: args.to,
    data,
    blockNumber: String(args.at.number),
    castCommand,
    expected: String(args.expected) as Uint,
    describes: args.describes,
  };
}
