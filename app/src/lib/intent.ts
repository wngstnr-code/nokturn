import type {Address} from "viem";
import {IntentFlags, IntentKind, SessionMask} from "@shared/types";

/// Field order is frozen. It mirrors IntentLib.INTENT_TYPEHASH in the contracts,
/// and a reordering here makes every signature this app produces unverifiable.
export const INTENT_TYPES = {
  Intent: [
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

export type IntentMessage = {
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
};

export const ALL_TRADING_SESSIONS =
  SessionMask.CLOSED_OVERNIGHT |
  SessionMask.PRE_MARKET |
  SessionMask.OPEN |
  SessionMask.POST_MARKET |
  SessionMask.CLOSED_WEEKEND;

export const AUCTION_SESSIONS = SessionMask.AUCTION_OPEN | SessionMask.AUCTION_CLOSE;

/*
 * Nonce and window are passed in rather than invented. The coordinator checks
 * both against a collectEnd it read from the chain, and a fork's clock has
 * nothing to do with the browser's.
 */
export function buildIntent(input: {
  owner: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  minBuyAmount: bigint;
  toleranceBps: number;
  partialFill: boolean;
  kind: IntentKind;
  nonce: bigint;
  chainTime: number;
  collectEndsAt: number;
  validForSeconds: number;
  batchSpan: number;
}): IntentMessage {
  const auction = input.kind !== IntentKind.SPOT;

  // Settlement._pull checks the intent against collectEnd, so a window that
  // closes before it is refused no matter how long it looks from here.
  const validUntil = Math.max(input.chainTime + input.validForSeconds, input.collectEndsAt);

  return {
    owner: input.owner,
    receiver: input.owner,
    sellToken: input.sellToken,
    buyToken: input.buyToken,
    sellAmount: input.sellAmount,
    minBuyAmount: input.minBuyAmount,
    validAfter: Math.min(input.chainTime, input.collectEndsAt),
    validUntil,
    flags: (input.partialFill ? IntentFlags.PARTIAL_FILL : 0) | (auction ? IntentFlags.AUCTION : 0),
    kind: input.kind,
    maxDevFromRefBps: input.toleranceBps,
    allowedSessions: auction ? AUCTION_SESSIONS : ALL_TRADING_SESSIONS,
    batchSpan: input.batchSpan,
    nonce: input.nonce,
  };
}

/// IntentPayload in packages/shared/api-types.ts keeps every uint256 a string.
export function serializeIntent(intent: IntentMessage): Record<string, string | number> {
  return {
    owner: intent.owner,
    receiver: intent.receiver,
    sellToken: intent.sellToken,
    buyToken: intent.buyToken,
    sellAmount: intent.sellAmount.toString(),
    minBuyAmount: intent.minBuyAmount.toString(),
    validAfter: intent.validAfter,
    validUntil: intent.validUntil,
    flags: intent.flags,
    kind: intent.kind,
    maxDevFromRefBps: intent.maxDevFromRefBps,
    allowedSessions: intent.allowedSessions,
    batchSpan: intent.batchSpan,
    nonce: intent.nonce.toString(),
  };
}
