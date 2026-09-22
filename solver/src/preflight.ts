// F22. A solver that is not bonded, not funded for gas, or not a bare account
// refuses to start, and says which command fixes it.
//
// Everything is read from the chain. A solver that trusted a file would start
// against a registry that has since slashed it and learn so from a revert on
// its first submitSolution, ten seconds into a window it cannot retry.

import {formatEther, formatUnits, type Address, type PublicClient} from "viem";
import {registryAbi} from "./abi.ts";
import type {Contracts} from "./chain.ts";

/**
 * One hour at one batch a minute is sixty submits and sixty finalizes. At 2M gas
 * each and the fork's base fee of 0.0589 gwei that is about 0.014 ETH, so this
 * leaves three hours of headroom before a finalize fails for want of gas.
 */
export const MIN_GAS_BALANCE = 5n * 10n ** 16n;

export interface Readiness {
  address: Address;
  active: boolean;
  bonded: bigint;
  minBond: bigint;
  unbondAvailableAt: bigint;
  balance: bigint;
  bare: boolean;
  problems: string[];
}

export async function readiness(c: PublicClient, k: Contracts, address: Address): Promise<Readiness> {
  const read = <T>(functionName: string, args: unknown[] = []) =>
    c.readContract({address: k.solvers, abi: registryAbi(), functionName, args}) as Promise<T>;
  const [active, [bonded, unbondAvailableAt], minBond, balance, code] = await Promise.all([
    read<boolean>("isActive", [address]),
    read<[bigint, bigint]>("bondOf", [address]),
    read<bigint>("minBond"),
    c.getBalance({address}),
    c.getCode({address}),
  ]);
  const bare = !code || code === "0x";

  const problems: string[] = [];
  if (bonded < minBond) problems.push(`bond ${formatUnits(bonded, 6)} USDG is under minBond ${formatUnits(minBond, 6)}. run: make fund`);
  if (unbondAvailableAt !== 0n) problems.push(`an unbond was requested, available at ${unbondAvailableAt}, so the registry no longer counts this solver. bond again with a fresh account, or run: make deploy fund`);
  if (!active && problems.length === 0) problems.push("SolverRegistry.isActive answers false for a reason this check does not know. read the registry before starting");
  if (balance < MIN_GAS_BALANCE) problems.push(`gas balance ${formatEther(balance)} ETH is under ${formatEther(MIN_GAS_BALANCE)}. run: make fund`);
  if (!bare) problems.push(`${address} carries code (${code!.slice(0, 10)}), so Permit2 and the registry see a contract. use an account from infra/accounts.json`);

  return {address, active, bonded, minBond, unbondAvailableAt: BigInt(unbondAvailableAt), balance, bare, problems};
}

export async function assertReady(c: PublicClient, k: Contracts, address: Address): Promise<Readiness> {
  const r = await readiness(c, k, address);
  if (r.problems.length > 0) throw new Error(`solver ${address} refuses to start\n  ${r.problems.join("\n  ")}`);
  return r;
}
