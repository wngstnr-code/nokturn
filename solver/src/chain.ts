// One client and one deployment record for the whole solver.
//
// Only Settlement's address comes from the record. Everything Settlement itself
// knows, the verifier, the oracle, the session manager and the baseline adapter,
// is read from Settlement on chain, because a record on disk can outlive a
// redeploy and the chain cannot.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import {BaseError, ContractFunctionRevertedError, createPublicClient, http, type Address, type PublicClient} from "viem";
import {REPO_ROOT, settlementAbi} from "./abi.ts";

export const RPC = process.env.NOKTURN_SOLVER_RPC ?? "http://127.0.0.1:8545";
export const API = process.env.NOKTURN_API_URL ?? "http://127.0.0.1:3000";
const RECORD = process.env.NOKTURN_SOLVER_DEPLOYMENT ?? join(REPO_ROOT, "infra", "fork-deployment.json");

export function client(rpc = RPC): PublicClient {
  return createPublicClient({transport: http(rpc, {timeout: 8_000, retryCount: 2})});
}

export function settlementAddress(): Address {
  const record = JSON.parse(readFileSync(RECORD, "utf8")) as {settlement?: Address};
  if (!record.settlement) throw new Error(`${RECORD} names no settlement. run make deploy`);
  return record.settlement;
}

export interface Contracts {
  settlement: Address;
  verifier: Address;
  oracle: Address;
  sessions: Address;
  solvers: Address;
  baselineAdapter: Address;
}

export async function contracts(c: PublicClient, settlement: Address, blockNumber?: bigint): Promise<Contracts> {
  const read = (functionName: string) => c.readContract({address: settlement, abi: settlementAbi(), functionName, blockNumber}) as Promise<Address>;
  const [verifier, oracle, sessions, solvers, baselineAdapter] = await Promise.all([
    read("verifier"),
    read("oracle"),
    read("sessions"),
    read("solvers"),
    read("baselineAdapter"),
  ]);
  return {settlement, verifier, oracle, sessions, solvers, baselineAdapter};
}

/**
 * The contract's own name for a revert, with its arguments, or null when the
 * failure was not a revert. Every ABI a solution touches is passed in by the
 * caller, so a revert from the adapter surfaces by name even through Settlement.
 */
export function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  const name = reverted.data?.errorName ?? reverted.reason ?? reverted.signature ?? "reverted";
  const args = reverted.data?.args?.map((a) => String(a)).join(", ");
  return args ? `${name}(${args})` : name;
}
