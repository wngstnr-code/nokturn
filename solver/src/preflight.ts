// F22. A solver that is not bonded, not funded for gas, or not a bare account
// refuses to start, and says which command fixes it.
//
// Everything is read from the chain. A solver that trusted a file would start
// against a registry that has since slashed it and learn so from a revert on
// its first submitSolution, ten seconds into a window it cannot retry.

import {formatEther, formatUnits, type Address, type PublicClient} from "viem";
import {registryAbi} from "./abi.ts";
import {isFork, withRetry, type Contracts} from "./chain.ts";

/**
 * One hour at one batch a minute is sixty submits and sixty finalizes, at up to
 * 2M gas each, and this asks for three such hours at the gas price the node
 * quotes now. A constant 0.05 ETH was sized on the fork's 0.0589 gwei, and
 * mainnet ran at 0.02 on 29 September 2026, so it asked a mainnet operator for
 * three times what the solver needs.
 */
export const GAS_PER_TX = 2_000_000n;
export const TX_PER_HOUR = 120n;
export const HOURS_OF_GAS = 3n;
export const minGasBalance = (gasPrice: bigint): bigint => gasPrice * GAS_PER_TX * TX_PER_HOUR * HOURS_OF_GAS;

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
  // withRetry, because this runs once at boot alongside contracts() and a
  // single transient RPC error here must not be indistinguishable from an
  // actually unbonded solver. See the comment on withRetry in chain.ts.
  const read = <T>(functionName: string, args: unknown[] = []) =>
    withRetry(() => c.readContract({address: k.solvers, abi: registryAbi(), functionName, args}) as Promise<T>);
  const [active, [bonded, unbondAvailableAt], minBond, balance, code, gasPrice, fork] = await Promise.all([
    read<boolean>("isActive", [address]),
    read<[bigint, bigint]>("bondOf", [address]),
    read<bigint>("minBond"),
    withRetry(() => c.getBalance({address})),
    withRetry(() => c.getCode({address})),
    withRetry(() => c.getGasPrice()),
    isFork(c),
  ]);
  const bare = !code || code === "0x";
  const minGas = minGasBalance(gasPrice);

  // On a fork make fund does all of it. Anywhere else it is real money, sent by
  // whoever holds the key, and nothing here sends it.
  const fix = fork
    ? {bond: "run: make fund", gas: "run: make fund", unbond: "bond again with a fresh account, or run: make deploy fund", code: "use an account from infra/accounts.json"}
    : {
        bond: `approve SolverRegistry ${k.solvers} for the USDG and call bond(${minBond}) from ${address}`,
        gas: `send ETH to ${address}`,
        unbond: "bond again from a fresh key",
        code: "use a key whose address has no code, EIP-7702 delegations included",
      };

  const problems: string[] = [];
  if (bonded < minBond) problems.push(`bond ${formatUnits(bonded, 6)} USDG is under minBond ${formatUnits(minBond, 6)}. ${fix.bond}`);
  if (unbondAvailableAt !== 0n) problems.push(`an unbond was requested, available at ${unbondAvailableAt}, so the registry no longer counts this solver. ${fix.unbond}`);
  if (!active && problems.length === 0) problems.push("SolverRegistry.isActive answers false for a reason this check does not know. read the registry before starting");
  if (balance < minGas) problems.push(`gas balance ${formatEther(balance)} ETH is under ${formatEther(minGas)}, three hours at ${formatUnits(gasPrice, 9)} gwei. ${fix.gas}`);
  if (!bare) problems.push(`${address} carries code (${code!.slice(0, 10)}), so Permit2 and the registry see a contract. ${fix.code}`);

  return {address, active, bonded, minBond, unbondAvailableAt: BigInt(unbondAvailableAt), balance, bare, problems};
}

export async function assertReady(c: PublicClient, k: Contracts, address: Address): Promise<Readiness> {
  const r = await readiness(c, k, address);
  if (r.problems.length > 0) throw new Error(`solver ${address} refuses to start\n  ${r.problems.join("\n  ")}`);
  return r;
}
