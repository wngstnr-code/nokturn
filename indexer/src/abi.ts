// ABIs come from packages/shared/abi, which forge build writes. Never a fragment
// written here, for the reason api/src/abi.ts gives.

import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import type {Abi} from "viem";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ABI_DIR = join(REPO_ROOT, "packages", "shared", "abi");
const cache = new Map<string, Abi>();

export function loadAbi(name: string): Abi {
  const hit = cache.get(name);
  if (hit) return hit;
  const path = join(ABI_DIR, `${name}.json`);
  let parsed: Abi;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Abi;
  } catch {
    throw new Error(`missing ${path}. run contracts/tools/export-abi.sh after forge build`);
  }
  cache.set(name, parsed);
  return parsed;
}

/** The contracts whose events are indexed, by the key their address has in the deployment record. */
export const INDEXED = {
  settlement: "Settlement",
  sessions: "SessionManager",
  oracle: "PriceOracle",
  solvers: "SolverRegistry",
  auctionHouse: "AuctionHouse",
  mandates: "AgentMandate",
} as const;

export type ContractKey = keyof typeof INDEXED;
