// Shared intent validation and escape hatch encoding.
//
// Extracted out of routes/escape.ts so POST /v1/intents and the escape hatch
// verify a signature and build the onchain payload exactly the same way. Two
// copies of this check would mean a signature that passes one and fails the
// other, and nobody would know which one was right.

import {encodeFunctionData, isAddress, type Abi, type Address, type Hex} from "viem";
import {chain, permit2Abi, read, settlementAbi} from "./chain.ts";
import {badRequest} from "./errors.ts";
import {env} from "./config.ts";
import {decodeIntent, witnessDigest, type DecodedIntent} from "./permit2.ts";

const intentTuple = {
  name: "i",
  type: "tuple",
  components: [
    {name: "owner", type: "address"},
    {name: "receiver", type: "address"},
    {name: "sellToken", type: "address"},
    {name: "buyToken", type: "address"},
    {name: "sellAmount", type: "uint256"},
    {name: "minBuyAmount", type: "uint256"},
    {name: "validAfter", type: "uint32"},
    {name: "validUntil", type: "uint32"},
    {name: "flags", type: "uint8"},
    {name: "kind", type: "uint8"},
    {name: "maxDevFromRefBps", type: "uint16"},
    {name: "allowedSessions", type: "uint8"},
    {name: "batchSpan", type: "uint16"},
    {name: "nonce", type: "uint256"},
  ],
} as const;

const submitOnchainAbi: Abi = [
  {
    type: "function",
    name: "submitIntentOnchain",
    stateMutability: "nonpayable",
    inputs: [intentTuple, {name: "sig", type: "bytes"}],
    outputs: [],
  },
];

const REQUIRED = intentTuple.components.map((c) => c.name);

export function validateIntentPayload(payload: unknown): DecodedIntent {
  const p = payload as Record<string, unknown> | undefined;
  if (!p) throw badRequest("COORDINATOR_INVALID_REQUEST", "intent is missing");
  for (const field of REQUIRED) {
    if (p[field] === undefined || p[field] === null) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", `intent.${field} is missing`);
    }
  }
  for (const field of ["owner", "receiver", "sellToken", "buyToken"]) {
    if (!isAddress(String(p[field]))) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", `intent.${field} is not an address`);
    }
  }
  try {
    return decodeIntent(payload as never);
  } catch {
    throw badRequest(
      "COORDINATOR_INVALID_REQUEST",
      "sellAmount, minBuyAmount and nonce are decimal strings in the smallest unit",
    );
  }
}

let cachedWitness: {domainSeparator: Hex; witnessTypeString: string} | null = null;

/**
 * The digest a signature over this intent has to match. domainSeparator and
 * WITNESS_TYPE_STRING never change for a live deployment, so they are read
 * once and cached rather than fetched on every request. Section 2.1 of
 * docs/rencana-backend.md asks for exactly this.
 */
export async function witnessDigestNow(intent: DecodedIntent): Promise<Hex> {
  const c = chain();
  if (!cachedWitness) {
    const [domainSeparator, witnessTypeString] = await Promise.all([
      read<Hex>(c.permit2, permit2Abi, "DOMAIN_SEPARATOR"),
      read<string>(c.deployment.settlement, settlementAbi, "WITNESS_TYPE_STRING"),
    ]);
    cachedWitness = {domainSeparator, witnessTypeString};
  }
  return witnessDigest({...cachedWitness, intent, spender: c.deployment.settlement});
}

export interface EscapeHatchPayload {
  to: Address;
  data: Hex;
  castCommand: string;
  describes: string;
}

/** Calldata for Settlement.submitIntentOnchain. Encodes and signs nothing. */
export function escapeHatchFor(intent: DecodedIntent, signature: Hex): EscapeHatchPayload {
  const c = chain();
  const data = encodeFunctionData({
    abi: submitOnchainAbi,
    functionName: "submitIntentOnchain",
    args: [intent, signature],
  });
  return {
    to: c.deployment.settlement,
    data,
    castCommand: `cast send ${c.deployment.settlement} ${data} --rpc-url ${env.rpc} --from ${intent.owner}`,
    describes: "Settlement.submitIntentOnchain",
  };
}
