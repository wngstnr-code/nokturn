// Whether an accepted intent can still be collected. D4 and N3.
//
// Admission checks one intent against the owner's balance, allowance and nonce
// at one moment. Two things break that. An owner can sign many intents against
// the same balance, D4, and any of the three can change after admission, N3.
// Either way Permit2 refuses the pull in finalize and the batch unwinds with
// IntentCollectionFailed, which costs every other participant their batch.
//
// Everything here is read at a block whose timestamp is at most the batch's
// solveEnd. finalize refuses anything earlier, Settlement.sol line 262, so at
// such a block the batch's own pulls have not happened and a spent nonce or a
// smaller balance means the owner moved, not that the batch settled.

import type {Address} from "viem";
import type {ApiError, SignedIntent} from "../../packages/shared/api-types.ts";
import {chain, erc20Abi, permit2Abi, read} from "./chain.ts";

export interface Withdrawal {
  intentHash: SignedIntent["intentHash"];
  owner: Address;
  rejection: ApiError;
}

export interface OwnerFacts {
  balance(owner: Address, token: Address): bigint;
  allowance(owner: Address, token: Address): bigint;
  nonceUsed(owner: Address, nonce: bigint): boolean;
}

const key = (owner: string, token: string) => `${owner.toLowerCase()}:${token.toLowerCase()}`;

/**
 * Keeps intents in the order given, which is the order they were admitted, and
 * lets each one draw on what the owner has left after the ones before it. The
 * first intent to overdraw is the one withdrawn, so an owner cannot push out an
 * earlier intent by signing a later one.
 */
export function screen(list: SignedIntent[], facts: OwnerFacts): {keep: SignedIntent[]; withdrawn: Withdrawal[]} {
  const drawn = new Map<string, bigint>();
  const keep: SignedIntent[] = [];
  const withdrawn: Withdrawal[] = [];
  for (const s of list) {
    const owner = s.intent.owner as Address;
    const token = s.intent.sellToken as Address;
    const amount = BigInt(s.intent.sellAmount);
    const nonce = BigInt(s.intent.nonce);
    const k = key(owner, token);
    const already = drawn.get(k) ?? 0n;
    const balance = facts.balance(owner, token);
    const allowance = facts.allowance(owner, token);

    let rejection: ApiError | null = null;
    if (facts.nonceUsed(owner, nonce)) {
      rejection = {code: "NonceAlreadyUsed", message: `nonce ${nonce} of ${owner} was spent after this intent was accepted`, detail: {owner, nonce: String(nonce)}};
    } else if (balance < already + amount) {
      rejection = {
        code: "COORDINATOR_INSUFFICIENT_BALANCE",
        message: `owner holds ${balance}, and this intent needs ${amount} on top of ${already} already committed`,
        detail: {balance: String(balance), committed: String(already), sellAmount: String(amount)},
      };
    } else if (allowance < already + amount) {
      rejection = {
        code: "COORDINATOR_PERMIT2_NOT_APPROVED",
        message: `Permit2 allowance is ${allowance}, and this intent needs ${amount} on top of ${already} already committed`,
        detail: {allowance: String(allowance), committed: String(already), sellAmount: String(amount)},
      };
    }

    if (rejection) {
      withdrawn.push({intentHash: s.intentHash, owner, rejection});
    } else {
      drawn.set(k, already + amount);
      keep.push(s);
    }
  }
  return {keep, withdrawn};
}

/** One read per owner and token, and one per owner and nonce word, all at one block. */
export async function readFacts(list: SignedIntent[], blockNumber?: bigint): Promise<OwnerFacts> {
  const c = chain();
  const pairs = new Map<string, [Address, Address]>();
  const words = new Map<string, [Address, bigint]>();
  for (const s of list) {
    const owner = s.intent.owner as Address;
    pairs.set(key(owner, s.intent.sellToken), [owner, s.intent.sellToken as Address]);
    const word = BigInt(s.intent.nonce) >> 8n;
    words.set(`${owner.toLowerCase()}:${word}`, [owner, word]);
  }

  const balances = new Map<string, bigint>();
  const allowances = new Map<string, bigint>();
  const bitmaps = new Map<string, bigint>();
  await Promise.all([
    ...[...pairs].map(async ([k, [owner, token]]) => {
      const [balance, allowance] = await Promise.all([
        read<bigint>(token, erc20Abi, "balanceOf", [owner], blockNumber),
        read<bigint>(token, erc20Abi, "allowance", [owner, c.permit2], blockNumber),
      ]);
      balances.set(k, balance);
      allowances.set(k, allowance);
    }),
    ...[...words].map(async ([k, [owner, word]]) => {
      bitmaps.set(k, await read<bigint>(c.permit2, permit2Abi, "nonceBitmap", [owner, word], blockNumber));
    }),
  ]);

  return {
    balance: (owner, token) => balances.get(key(owner, token)) ?? 0n,
    allowance: (owner, token) => allowances.get(key(owner, token)) ?? 0n,
    nonceUsed: (owner, nonce) => {
      const bitmap = bitmaps.get(`${owner.toLowerCase()}:${nonce >> 8n}`) ?? 0n;
      return (bitmap >> (nonce % 256n)) % 2n === 1n;
    },
  };
}
