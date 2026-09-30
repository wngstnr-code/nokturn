// Shared by the fork tests. The demo users and a local Permit2 witness
// signature through api/src/permit2.ts, the same digest the coordinator
// verifies submissions against, so there is no third encoding to drift.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import {encodeFunctionData, type Address, type Hex, type PublicClient} from "viem";
import {mnemonicToAccount, type HDAccount} from "viem/accounts";
import {witnessDigest} from "../../../api/src/permit2.ts";
import {PERMIT2, USDG} from "../../../packages/shared/addresses.ts";
import {REPO_ROOT, loadAbi, settlementAbi} from "../../src/abi.ts";
import {quoteOf} from "../../src/cross.ts";
import type {Intent} from "../../src/solution.ts";

/** infra/scripts/sign-intent.mjs derives users[i] at index 6 + i and checks it. */
const USER_INDEX_BASE = 6;

export function users(): HDAccount[] {
  const file = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "accounts.json"), "utf8")) as {_mnemonic: string; users: Address[]};
  const mnemonic = process.env.NOKTURN_FORK_MNEMONIC ?? file._mnemonic;
  return file.users.map((expected, i) => {
    const account = mnemonicToAccount(mnemonic, {addressIndex: USER_INDEX_BASE + i});
    if (account.address.toLowerCase() !== expected.toLowerCase()) throw new Error(`index ${USER_INDEX_BASE + i} is not users[${i}]`);
    return account;
  });
}

export async function sign(c: PublicClient, settlement: Address, account: HDAccount, intent: Intent): Promise<Hex> {
  const [domainSeparator, witnessTypeString] = await Promise.all([
    c.readContract({address: PERMIT2, abi: loadAbi("ISignatureTransfer"), functionName: "DOMAIN_SEPARATOR"}) as Promise<Hex>,
    c.readContract({address: settlement, abi: settlementAbi(), functionName: "WITNESS_TYPE_STRING"}) as Promise<string>,
  ]);
  return account.sign({hash: witnessDigest({domainSeparator, witnessTypeString, intent, spender: settlement})});
}

const FLAG_AUCTION = 1 << 2;
const SESSION_MASK_AUCTION_CLOSE = 1 << 4;
const MOO = 1;

/** A market on close commitment to AuctionHouse, signed as its Permit2 witness. */
export async function commitAuction(c: PublicClient, house: Address, user: HDAccount, token: Address, sell: boolean, amount: bigint, nonce: bigint): Promise<void> {
  const houseAbi = loadAbi("AuctionHouse");
  const intent: Intent = {
    ...intentFor(user.address, {sellToken: sell ? token : (USDG as Address), buyToken: sell ? (USDG as Address) : token, sellAmount: amount, minBuyAmount: 1n}),
    validUntil: Number((await c.getBlock()).timestamp + 7_200n),
    flags: FLAG_AUCTION,
    kind: MOO,
    allowedSessions: SESSION_MASK_AUCTION_CLOSE,
    nonce,
  };
  const [domainSeparator, witnessTypeString] = await Promise.all([
    c.readContract({address: PERMIT2, abi: loadAbi("ISignatureTransfer"), functionName: "DOMAIN_SEPARATOR"}) as Promise<Hex>,
    c.readContract({address: house, abi: houseAbi, functionName: "WITNESS_TYPE_STRING"}) as Promise<string>,
  ]);
  const sig = await user.sign({hash: witnessDigest({domainSeparator, witnessTypeString, intent, spender: house})});
  const data = encodeFunctionData({abi: houseAbi, functionName: "commitAuctionIntent", args: [intent, sig]});
  const hash = (await c.request({method: "eth_sendTransaction" as never, params: [{from: user.address, to: house, data}] as never})) as Hex;
  const receipt = await c.waitForTransactionReceipt({hash});
  if (receipt.status !== "success") throw new Error(`commit by ${user.address} reverted`);
}

/**
 * Two sellers with odd amounts and three buyers who together bring half a
 * percent more than the sellers' tokens are worth at the reference. That is the
 * side the contract's own price cannot cross, so it exercises the keeper's
 * balancing. Four distinct owners, one short of a closing print.
 */
export async function fillAuctionBook(c: PublicClient, house: Address, oracle: Address, token: Address, people: HDAccount[], nextNonce: () => bigint): Promise<void> {
  const [ref] = (await c.readContract({address: oracle, abi: loadAbi("PriceOracle"), functionName: "refPrice", args: [token]})) as [bigint, bigint, boolean];
  const price = (ref * 10n ** 6n) / 10n ** 18n;
  const sells = [1_234_567_890_123_456_789n, 800_000_000_000_000_001n];
  await commitAuction(c, house, people[0]!, token, true, sells[0]!, nextNonce());
  await commitAuction(c, house, people[1]!, token, true, sells[1]!, nextNonce());
  const worth = (quoteOf(sells[0]! + sells[1]!, price) * 1_005n) / 1_000n;
  await commitAuction(c, house, people[2]!, token, false, worth / 3n + 17n, nextNonce());
  await commitAuction(c, house, people[3]!, token, false, worth / 3n - 11n, nextNonce());
  await commitAuction(c, house, people[2]!, token, false, worth - 2n * (worth / 3n) - 6n, nextNonce());
}

export function intentFor(owner: Address, fields: Pick<Intent, "sellToken" | "buyToken" | "sellAmount" | "minBuyAmount"> & Partial<Intent>): Intent {
  return {
    owner,
    receiver: owner,
    validAfter: 0,
    validUntil: 2_000_000_000,
    flags: 0,
    kind: 0,
    maxDevFromRefBps: 0,
    allowedSessions: 0xff,
    batchSpan: 1,
    nonce: 0n,
    ...fields,
  };
}
