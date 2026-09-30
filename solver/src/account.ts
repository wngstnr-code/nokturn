// The solver's key, derived from the project's throwaway fork mnemonic.
//
// infra/accounts.json explains why these accounts exist at all. Anvil's default
// keys are public, somebody has delegated all ten of them with EIP-7702 on
// mainnet 4663, and a forked account with code sends Permit2 down the EIP-1271
// path. The same applies to a solver, so the address is asserted bare before it
// signs anything.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import type {Address, Hex, PublicClient} from "viem";
import {mnemonicToAccount, privateKeyToAccount, type HDAccount, type LocalAccount} from "viem/accounts";
import {REPO_ROOT} from "./abi.ts";
import {isFork} from "./chain.ts";

/** Found by deriving indices 0 to 20 and matching infra/accounts.json solverA and solverB. */
export const SOLVER_A_INDEX = 4;
export const SOLVER_B_INDEX = 5;

/** a nets first and routes the rest. b routes every intent, the way an aggregator does. */
export type Profile = "a" | "b";

interface AccountsFile {
  _mnemonic: string;
  solverA: Address;
  solverB: Address;
}

function accountsFile(): AccountsFile {
  return JSON.parse(readFileSync(join(REPO_ROOT, "infra", "accounts.json"), "utf8")) as AccountsFile;
}

export function solverAccount(profile: Profile = "a"): HDAccount {
  const file = accountsFile();
  const mnemonic = process.env.NOKTURN_FORK_MNEMONIC ?? file._mnemonic;
  const [index, name] = profile === "a" ? [SOLVER_A_INDEX, "solverA" as const] : [SOLVER_B_INDEX, "solverB" as const];
  const account = mnemonicToAccount(mnemonic, {addressIndex: index});
  if (account.address.toLowerCase() !== file[name].toLowerCase()) {
    throw new Error(`index ${index} derives ${account.address}, but infra/accounts.json names ${file[name]} as ${name}`);
  }
  return account;
}

/**
 * The key that signs, for the chain the node is on. A fork keeps the repo's
 * mnemonic. Anywhere else the key comes from the environment, because the
 * mnemonic is committed and public, and a bond of 500 USDG behind it belongs to
 * whoever reads the repo first. A key that turns out to be one of the repo's
 * accounts is refused for the same reason.
 */
export async function signer(c: PublicClient, profile: Profile = "a"): Promise<LocalAccount> {
  if (await isFork(c)) return solverAccount(profile);
  const variable = profile === "a" ? "NOKTURN_SOLVER_PRIVATE_KEY" : "NOKTURN_SOLVER_B_PRIVATE_KEY";
  const key = process.env[variable];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`this node is not a fork, so profile ${profile} signs with the key in ${variable}, and that is ${key ? "not a 32 byte hex key" : "not set"}. the repo mnemonic is public and never signs off a fork`);
  }
  const account = privateKeyToAccount(key as Hex);
  const published = Object.values(accountsFile() as unknown as Record<string, unknown>).flat().filter((v): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v));
  if (published.some((a) => a.toLowerCase() === account.address.toLowerCase())) {
    throw new Error(`${variable} is ${account.address}, an account of the public repo mnemonic in infra/accounts.json. use a key nobody else holds`);
  }
  return account;
}

export async function assertBare(client: PublicClient, address: Address): Promise<void> {
  const code = await client.getCode({address});
  if (code && code !== "0x") {
    throw new Error(`${address} carries code (${code.slice(0, 10)}), so it cannot be used as the solver`);
  }
}
