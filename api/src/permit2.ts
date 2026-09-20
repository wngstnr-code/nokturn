// The digest Permit2 actually verifies.
//
// This is fact one of docs/rencana-backend.md section 2, and the mistake it
// prevents is the one that costs a day. A user does not sign an Intent. They
// sign a Permit2 PermitWitnessTransferFrom whose witness is the Intent hash,
// and recovering against the Intent hash instead gives a clean looking wrong
// answer with nothing saying why.
//
// Mirrored from contracts/src/libraries/Permit2Witness.sol and IntentLib.sol.
// The type string is read from the deployed Settlement rather than copied, so
// if the contract ever changes it this follows rather than silently diverging.

import {concatHex, encodeAbiParameters, keccak256, toHex, type Address, type Hex} from "viem";
import type {IntentPayload} from "../../packages/shared/api-types.ts";
import {INTENT_TYPE_STRING} from "./chain.ts";

/** Permit2's own, unchanged. */
const TOKEN_PERMISSIONS_TYPEHASH = keccak256(toHex("TokenPermissions(address token,uint256 amount)"));

/** What Permit2 puts in front of the caller's witness type. */
const TYPEHASH_STUB =
  "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

export const INTENT_TYPEHASH = keccak256(toHex(INTENT_TYPE_STRING));

export interface DecodedIntent {
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

/** IntentLib.hash. Field order is frozen, because the encoding depends on it. */
export function intentHash(i: DecodedIntent): Hex {
  return keccak256(
    concatHex([
      encodeAbiParameters(
        [
          {type: "bytes32"},
          {type: "address"},
          {type: "address"},
          {type: "address"},
          {type: "address"},
          {type: "uint256"},
          {type: "uint256"},
        ],
        [INTENT_TYPEHASH, i.owner, i.receiver, i.sellToken, i.buyToken, i.sellAmount, i.minBuyAmount],
      ),
      encodeAbiParameters(
        [
          {type: "uint32"},
          {type: "uint32"},
          {type: "uint8"},
          {type: "uint8"},
          {type: "uint16"},
          {type: "uint8"},
          {type: "uint16"},
          {type: "uint256"},
        ],
        [
          i.validAfter,
          i.validUntil,
          i.flags,
          i.kind,
          i.maxDevFromRefBps,
          i.allowedSessions,
          i.batchSpan,
          i.nonce,
        ],
      ),
    ]),
  );
}

/**
 * Permit2Witness.digest.
 *
 * @param spender The contract that will call Permit2. Always Settlement, since
 * Permit2 binds a signature to its own msg.sender and nobody else can spend it.
 */
export function witnessDigest(args: {
  domainSeparator: Hex;
  witnessTypeString: string;
  intent: DecodedIntent;
  spender: Address;
}): Hex {
  const witnessTypeHash = keccak256(toHex(TYPEHASH_STUB + args.witnessTypeString));

  const permitted = keccak256(
    encodeAbiParameters(
      [{type: "bytes32"}, {type: "address"}, {type: "uint256"}],
      [TOKEN_PERMISSIONS_TYPEHASH, args.intent.sellToken, args.intent.sellAmount],
    ),
  );

  const dataHash = keccak256(
    encodeAbiParameters(
      [{type: "bytes32"}, {type: "bytes32"}, {type: "address"}, {type: "uint256"}, {type: "uint256"}, {type: "bytes32"}],
      [
        witnessTypeHash,
        permitted,
        args.spender,
        args.intent.nonce,
        // Permit2 reads the deadline, and Settlement passes validUntil into it,
        // so an intent expires for Permit2 at exactly the moment it expires for
        // the protocol.
        BigInt(args.intent.validUntil),
        intentHash(args.intent),
      ],
    ),
  );

  return keccak256(concatHex(["0x1901", args.domainSeparator, dataHash]));
}

/** Turns the JSON shape back into the widths the encoders expect. */
export function decodeIntent(payload: IntentPayload): DecodedIntent {
  const p = payload as unknown as Record<string, string | number>;
  return {
    owner: p.owner as Address,
    receiver: p.receiver as Address,
    sellToken: p.sellToken as Address,
    buyToken: p.buyToken as Address,
    sellAmount: BigInt(p.sellAmount as string),
    minBuyAmount: BigInt(p.minBuyAmount as string),
    validAfter: Number(p.validAfter),
    validUntil: Number(p.validUntil),
    flags: Number(p.flags),
    kind: Number(p.kind),
    maxDevFromRefBps: Number(p.maxDevFromRefBps),
    allowedSessions: Number(p.allowedSessions),
    batchSpan: Number(p.batchSpan),
    nonce: BigInt(p.nonce as string),
  };
}
