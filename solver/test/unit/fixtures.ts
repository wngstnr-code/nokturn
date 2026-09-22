import type {Address} from "viem";
import {STOCK_TOKENS, USDG} from "../../../packages/shared/addresses.ts";
import type {Intent, Solution} from "../../src/solution.ts";

export const NVDA = STOCK_TOKENS.NVDA as Address;
export const TSLA = STOCK_TOKENS.TSLA as Address;
export const AAPL = STOCK_TOKENS.AAPL as Address;
export const QUOTE = USDG as Address;

export const OWNER_A = "0xC3E87ba4132708838243A717C4B90112271ceeE3" as Address;
export const OWNER_B = "0x14e9Ef9fd45e6B1e8dBc229DDc3212dB1d21a0ab" as Address;

export function intent(fields: Partial<Intent> & Pick<Intent, "sellToken" | "buyToken" | "sellAmount" | "minBuyAmount">): Intent {
  return {
    owner: OWNER_A,
    receiver: OWNER_A,
    validAfter: 0,
    validUntil: 1_800_000_000,
    flags: 0,
    kind: 0,
    maxDevFromRefBps: 0,
    allowedSessions: 0xff,
    batchSpan: 1,
    nonce: 1n,
    ...fields,
  };
}

/** A small deterministic generator, so a failing property names a seed that reproduces it. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  return {
    int: (lo: number, hi: number) => lo + (next() % (hi - lo + 1)),
    big: (lo: bigint, hi: bigint) => lo + ((BigInt(next()) << 32n) | BigInt(next())) % (hi - lo + 1n),
    bool: () => (next() & 1) === 1,
  };
}

export function solution(fields: Partial<Solution> = {}): Solution {
  const intents = [
    intent({sellToken: QUOTE, buyToken: NVDA, sellAmount: 1_000_000_000n, minBuyAmount: 5_000_000_000_000_000_000n}),
    intent({owner: OWNER_B, receiver: OWNER_B, sellToken: NVDA, buyToken: QUOTE, sellAmount: 5_000_000_000_000_000_000n, minBuyAmount: 900_000_000n, nonce: 2n}),
  ];
  return {
    batchId: 1_789_900_000n,
    intents,
    signatures: ["0x11", "0x22"],
    tokens: [QUOTE, NVDA],
    prices: [1_000_000_000_000_000_000_000_000_000_000n, 190_000_000_000_000_000n],
    executions: [
      {intentIndex: 0n, executedSell: 1_000_000_000n, executedBuy: 5_200_000_000_000_000_000n},
      {intentIndex: 1n, executedSell: 5_000_000_000_000_000_000n, executedBuy: 950_000_000n},
    ],
    venueCalls: [],
    baselineQuotes: [5_100_000_000_000_000_000n, 940_000_000n],
    claimedSavings: 0n,
    solver: "0x86d9065C8Bc1f0fa29d02cA873523C19C7859F95",
    ...fields,
  };
}
