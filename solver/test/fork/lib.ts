// Shared by the fork tests. The demo users and a local Permit2 witness
// signature through api/src/permit2.ts, the same digest the coordinator
// verifies submissions against, so there is no third encoding to drift.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import type {Address, Hex, PublicClient} from "viem";
import {mnemonicToAccount, type HDAccount} from "viem/accounts";
import {witnessDigest} from "../../../api/src/permit2.ts";
import {PERMIT2} from "../../../packages/shared/addresses.ts";
import {REPO_ROOT, loadAbi, settlementAbi} from "../../src/abi.ts";
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
