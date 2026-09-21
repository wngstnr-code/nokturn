// ABIs come from packages/shared/abi, which forge build writes and
// contracts/tools/export-abi.sh publishes.
//
// They were hand written here until 21 September 2026, and that was a mistake
// of the exact kind CLAUDE.md warns about. Forty inline fragments covered
// eleven of Settlement's thirty six functions and six of the adapter's eight
// errors, so a revert the contract has a name for came back as a bare selector.
// A hand written ABI is a second definition of something that already has one,
// and it goes stale without anything failing.
//
// Read at boot rather than imported, so the loader has one place to say which
// file was missing instead of failing inside a module graph.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import type {Abi} from "viem";
import {REPO_ROOT} from "./config.ts";

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
export const sessionAbi = () => loadAbi("SessionManager");
export const oracleAbi = () => loadAbi("PriceOracle");
export const adapterAbi = () => loadAbi("UniswapV3Adapter");
export const registryAbi = () => loadAbi("SolverRegistry");
export const permit2Abi = () => loadAbi("ISignatureTransfer");
export const multiplierAbi = () => loadAbi("IUiMultiplier");

/**
 * The two things no generated ABI covers.
 *
 * ERC20 is not a contract this protocol owns, so nothing in src declares it.
 * And invalidateUnorderedNonces is real on the deployed Permit2 but absent from
 * IPermit2.sol, which only declares the slice Settlement calls. Cancelling an
 * intent is a user action rather than a protocol one, so the interface has no
 * reason to carry it.
 */
export const erc20Abi: Abi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint8"}],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "string"}],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{name: "owner", type: "address"}],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      {name: "owner", type: "address"},
      {name: "spender", type: "address"},
    ],
    outputs: [{type: "uint256"}],
  },
];

export const invalidateNoncesAbi: Abi = [
  {
    type: "function",
    name: "invalidateUnorderedNonces",
    stateMutability: "nonpayable",
    inputs: [
      {name: "wordPos", type: "uint256"},
      {name: "mask", type: "uint256"},
    ],
    outputs: [],
  },
];
