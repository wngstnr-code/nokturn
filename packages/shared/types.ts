// Mirror of contracts/src/types/Types.sol. Keep field order identical to the
// struct, because the EIP-712 encoding depends on it.

export enum Session {
  CLOSED_OVERNIGHT = 0,
  PRE_MARKET = 1,
  AUCTION_OPEN = 2,
  OPEN = 3,
  AUCTION_CLOSE = 4,
  POST_MARKET = 5,
  CLOSED_WEEKEND = 6,
  HOLIDAY = 7,
  PROTECTIVE = 8,
}

export enum IntentKind {
  SPOT = 0,
  MOO = 1,
  LOO = 2,
  ROO = 3,
}

export const IntentFlags = {
  PARTIAL_FILL: 1 << 0,
  AGENT_SIGNED: 1 << 1,
  AUCTION: 1 << 2,
} as const;

// PROTECTIVE has no bit. An intent can never opt into a session the protocol
// enters only because it stopped trusting its own inputs.
export const SessionMask = {
  CLOSED_OVERNIGHT: 1 << 0,
  PRE_MARKET: 1 << 1,
  AUCTION_OPEN: 1 << 2,
  OPEN: 1 << 3,
  AUCTION_CLOSE: 1 << 4,
  POST_MARKET: 1 << 5,
  CLOSED_WEEKEND: 1 << 6,
  HOLIDAY: 1 << 7,
} as const;

export interface Intent {
  owner: `0x${string}`;
  receiver: `0x${string}`;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
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
  adapter: `0x${string}`;
  data: `0x${string}`;
}

export interface Solution {
  batchId: bigint;
  intents: Intent[];
  signatures: `0x${string}`[];
  tokens: `0x${string}`[];
  prices: bigint[];
  executions: Execution[];
  venueCalls: VenueCall[];
  baselineQuotes: bigint[];
  claimedSavings: bigint;
  solver: `0x${string}`;
}

// viem signTypedData types. The order matches INTENT_TYPEHASH exactly.
export const INTENT_EIP712_TYPES = {
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

// Frozen on day one and asserted in contracts/test/IntentLib.t.sol.
export const INTENT_TYPEHASH =
  "0x8ebd7b3cd239d387958c175546883600864ae3d16e2e9c87d8d5714bf8c138a4" as const;

export const EIP712_DOMAIN_NAME = "Nokturn" as const;
export const EIP712_DOMAIN_VERSION = "1" as const;
