// One client and one deployment record for the whole solver.
//
// Only Settlement's address comes from the record. Everything Settlement itself
// knows, the verifier, the oracle, the session manager and the baseline adapter,
// is read from Settlement on chain, because a record on disk can outlive a
// redeploy and the chain cannot.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import {BaseError, ContractFunctionRevertedError, createPublicClient, decodeErrorResult, http, type Abi, type Address, type Hex, type PublicClient} from "viem";
import {unknownMethod} from "../../packages/shared/rpc.ts";
import {REPO_ROOT, settlementAbi} from "./abi.ts";

export const RPC = process.env.NOKTURN_SOLVER_RPC ?? "http://127.0.0.1:8545";
export const API = process.env.NOKTURN_API_URL ?? "http://127.0.0.1:3000";
const RECORD = process.env.NOKTURN_SOLVER_DEPLOYMENT ?? join(REPO_ROOT, "infra", "fork-deployment.json");

export function client(rpc = RPC): PublicClient {
  // No block number cache, so a batch is solved at the real head and not at one
  // up to four seconds old, which after an evm_revert may not exist at all.
  return createPublicClient({cacheTime: 0, transport: http(rpc, {timeout: 8_000, retryCount: 2})});
}

/** Asked of the node. Only a node that does not know anvil_nodeInfo is a real chain. */
export async function isFork(c: PublicClient): Promise<boolean> {
  try {
    await withRetry(() => c.request({method: "anvil_nodeInfo" as never, params: [] as never}), 3);
    return true;
  } catch (error) {
    if (unknownMethod(error)) return false;
    throw error;
  }
}

/**
 * The deployment record for the chain the node is on. A solver pointed at
 * mainnet with the fork record would read a Settlement address that on mainnet
 * is nobody's.
 */
export async function deploymentRecord(c: PublicClient): Promise<{path: string; record: Record<string, Address>}> {
  const path =
    process.env.NOKTURN_SOLVER_DEPLOYMENT ??
    ((await isFork(c)) ? join(REPO_ROOT, "infra", "fork-deployment.json") : join(REPO_ROOT, "contracts", "deployments", `${await withRetry(() => c.getChainId())}.json`));
  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, Address>;
  if (!record.settlement) throw new Error(`${path} names no settlement`);
  return {path, record};
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

/**
 * A JSON-RPC error response is a normal, final answer as far as the transport's
 * own retryCount is concerned, so a proxy or a node that returns one instead of
 * an HTTP 5xx is never retried there. E4 found this the hard way, five reads at
 * boot against 30 percent RPC errors, and the solver crashed before it processed
 * a single batch. This is the same tolerance untilBlock gives a failed poll,
 * moved to the one-shot reads that run once at startup.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5, baseDelayMs = 250): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

export async function contracts(c: PublicClient, settlement: Address, blockNumber?: bigint): Promise<Contracts> {
  const read = (functionName: string) => withRetry(() => c.readContract({address: settlement, abi: settlementAbi(), functionName, blockNumber}) as Promise<Address>);
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
export function revertName(error: unknown, abi?: Abi): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    const name = reverted.data?.errorName ?? reverted.reason ?? reverted.signature ?? "reverted";
    const args = reverted.data?.args?.map((a) => String(a)).join(", ");
    return args ? `${name}(${args})` : name;
  }
  // A raw eth_call or estimateGas carries the revert bytes with no ABI to read
  // them, so a custom error came back as its selector and the keeper could not
  // tell TooEarly, which means wait, from a refusal.
  if (!abi) return null;
  const raw = error.walk((e) => typeof (e as {data?: unknown}).data === "string" && /^0x[0-9a-fA-F]{8}/.test((e as {data: string}).data));
  if (!raw) return null;
  try {
    const decoded = decodeErrorResult({abi, data: (raw as unknown as {data: Hex}).data});
    const args = decoded.args?.map((a) => String(a)).join(", ");
    return args ? `${decoded.errorName}(${args})` : decoded.errorName;
  } catch {
    return null;
  }
}
