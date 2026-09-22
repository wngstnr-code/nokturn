// ABIs come from packages/shared/abi, which forge build writes and
// contracts/tools/export-abi.sh publishes. Nothing here is written by hand,
// for the reason api/src/abi.ts gives. A hand written fragment is a second
// definition of something that already has one, and it goes stale silently.

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

export const settlementAbi = () => loadAbi("Settlement");
export const verifierAbi = () => loadAbi("ClearingVerifier");
export const adapterAbi = () => loadAbi("UniswapV3Adapter");
export const oracleAbi = () => loadAbi("PriceOracle");
export const sessionAbi = () => loadAbi("SessionManager");
export const registryAbi = () => loadAbi("SolverRegistry");
