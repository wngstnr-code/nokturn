// The solver's key, derived from the project's throwaway fork mnemonic.
//
// infra/accounts.json explains why these accounts exist at all. Anvil's default
// keys are public, somebody has delegated all ten of them with EIP-7702 on
// mainnet 4663, and a forked account with code sends Permit2 down the EIP-1271
// path. The same applies to a solver, so the address is asserted bare before it
// signs anything.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import type {Address, PublicClient} from "viem";
import {mnemonicToAccount, type HDAccount} from "viem/accounts";
import {REPO_ROOT} from "./abi.ts";

/** Found by deriving indices 0 to 20 and matching infra/accounts.json solverA. */
export const SOLVER_A_INDEX = 4;

interface AccountsFile {
  _mnemonic: string;
  solverA: Address;
}

function accountsFile(): AccountsFile {
  return JSON.parse(readFileSync(join(REPO_ROOT, "infra", "accounts.json"), "utf8")) as AccountsFile;
}

export function solverAccount(): HDAccount {
  const file = accountsFile();
  const mnemonic = process.env.NOKTURN_FORK_MNEMONIC ?? file._mnemonic;
  const account = mnemonicToAccount(mnemonic, {addressIndex: SOLVER_A_INDEX});
  if (account.address.toLowerCase() !== file.solverA.toLowerCase()) {
    throw new Error(`index ${SOLVER_A_INDEX} derives ${account.address}, but infra/accounts.json names ${file.solverA} as solverA`);
  }
  return account;
}

export async function assertBare(client: PublicClient, address: Address): Promise<void> {
  const code = await client.getCode({address});
  if (code && code !== "0x") {
    throw new Error(`${address} carries code (${code.slice(0, 10)}), so it cannot be used as the solver`);
  }
}
