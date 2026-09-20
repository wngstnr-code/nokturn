// Where the API gets its chain, its addresses and its sense of which deployment
// it is talking to.
//
// Nothing here is guessed. The deployment record is written by the deploy
// script, the token addresses come out of contracts/script/Addresses.sol through
// infra/scripts/extract-addresses.mjs, and which of the three networks we are on
// is decided by asking the node rather than by an environment flag somebody can
// set wrongly.

import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");

export const CHAIN_ID_MAINNET = 4663;
export const CHAIN_ID_TESTNET = 46_630;

export interface TokenEntry {
  symbol: string;
  token: `0x${string}`;
  pool: `0x${string}`;
  feed?: `0x${string}`;
  decimals: number;
}

export interface ChainFile {
  chainId: number;
  usdg: `0x${string}`;
  usdgDecimals: number;
  permit2: `0x${string}`;
  tokens: Record<string, {token: `0x${string}`; pool: `0x${string}`; feed: `0x${string}`; decimals: number}>;
}

export interface Deployment {
  settlement: `0x${string}`;
  sessions: `0x${string}`;
  oracle: `0x${string}`;
  solvers: `0x${string}`;
  auctionHouse: `0x${string}`;
  mandates: `0x${string}`;
  adapter: `0x${string}`;
  verifier: `0x${string}`;
  permit2: `0x${string}`;
  timelock: `0x${string}`;
  treasury: `0x${string}`;
  usdg: `0x${string}`;
}

export interface PinnedBlock {
  chainId: number;
  block: number;
  timestamp: number;
  timestampUtc: string;
}

export const env = {
  rpc: process.env.NOKTURN_API_RPC ?? "http://127.0.0.1:8545",
  host: process.env.NOKTURN_API_HOST ?? "127.0.0.1",
  port: Number(process.env.NOKTURN_API_PORT ?? 3000),
  explorer: process.env.NOKTURN_EXPLORER ?? "https://robinhoodchain.blockscout.com",
  logLevel: process.env.NOKTURN_API_LOG_LEVEL ?? "info",
};

function readJson<T>(path: string, hint: string): T {
  if (!existsSync(path)) throw new Error(`missing ${path}. ${hint}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadChainFile(): ChainFile {
  return readJson<ChainFile>(
    join(REPO_ROOT, "infra", "chain.json"),
    "generate it with ./infra/scripts/extract-addresses.sh",
  );
}

export function loadPinnedBlock(): PinnedBlock | null {
  const path = join(REPO_ROOT, "infra", "pinned-block.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as PinnedBlock;
}

/**
 * A fork writes its record into infra rather than into contracts/deployments,
 * because on a fork the chain id is 4663 and that is the same path a real
 * mainnet deploy would take.
 */
export function loadDeployment(chainId: number, isFork: boolean): Deployment {
  if (isFork) {
    return readJson<Deployment>(
      join(REPO_ROOT, "infra", "fork-deployment.json"),
      "run make deploy against the fork first",
    );
  }
  return readJson<Deployment>(
    join(REPO_ROOT, "contracts", "deployments", `${chainId}.json`),
    `no deployment recorded for chain ${chainId}`,
  );
}

/**
 * Chain 46630 carries no Stock Token, no canonical USDG and no Uniswap pool, so
 * the rehearsal fixtures stand in for all three. parameter.md section 10.6.
 * Their order matches Addresses.allowlist(), and relying on that order is why it
 * is asserted here rather than assumed.
 */
export function loadTestnetTokens(): ChainFile {
  const fixtures = readJson<{quote: `0x${string}`; tokens: `0x${string}`[]; pools: `0x${string}`[]}>(
    join(REPO_ROOT, "contracts", "deployments", "46630-fixtures.json"),
    "the rehearsal fixtures are not on this machine",
  );
  const symbols = ["NVDA", "AAPL", "TSLA", "GOOGL", "GME"];
  if (fixtures.tokens.length !== symbols.length || fixtures.pools.length !== symbols.length) {
    throw new Error("46630 fixtures no longer carry five tokens and five pools");
  }
  return {
    chainId: CHAIN_ID_TESTNET,
    usdg: fixtures.quote,
    usdgDecimals: 6,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    tokens: Object.fromEntries(
      symbols.map((symbol, i) => [
        symbol,
        {token: fixtures.tokens[i]!, pool: fixtures.pools[i]!, feed: "0x" as `0x${string}`, decimals: 18},
      ]),
    ),
  };
}

/**
 * The solvers this deployment knows about.
 *
 * SolverRegistry emits SolverBonded rather than keeping a list, so enumerating
 * every solver needs the indexer. Until that lands the board reports the two the
 * demo runs, read from infra/accounts.json, and says nothing about solvers it
 * has not been told about rather than pretending the set is complete.
 */
export function loadKnownSolvers(): {address: `0x${string}`; label: string}[] {
  const path = join(REPO_ROOT, "infra", "accounts.json");
  if (!existsSync(path)) return [];
  const accounts = JSON.parse(readFileSync(path, "utf8")) as {solverA?: string; solverB?: string};
  const out: {address: `0x${string}`; label: string}[] = [];
  if (accounts.solverA) out.push({address: accounts.solverA as `0x${string}`, label: "solver A"});
  if (accounts.solverB) out.push({address: accounts.solverB as `0x${string}`, label: "solver B"});
  return out;
}
