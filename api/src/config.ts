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
import {parseRpcList} from "../../packages/shared/rpc.ts";

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

const rpcs = parseRpcList(process.env.NOKTURN_API_RPC || "http://127.0.0.1:8545");

export const env = {
  /** Every endpoint the API may read from, first primary, the rest fallbacks. F6. */
  rpcs,
  rpc: rpcs[0]!,
  /**
   * The url printed in every cast command a caller or a judge copies. Kept
   * apart from the read list, because a paid endpoint carries its key in the
   * path and would otherwise be published in every receipt.
   */
  publicRpc: process.env.NOKTURN_API_PUBLIC_RPC || rpcs[0]!,
  /** Requests per minute above which the log warns. Nothing is refused. */
  rpcBudgetPerMinute: Number(process.env.NOKTURN_API_RPC_BUDGET_PER_MINUTE || 6000),
  // Alchemy's free tier refuses eth_getLogs over more than 10 blocks, and
  // mainnet seals about ten a second. Set 10 there.
  logBlockRange: BigInt(process.env.NOKTURN_API_LOG_BLOCK_RANGE || 1000),
  host: process.env.NOKTURN_API_HOST ?? "127.0.0.1",
  port: Number(process.env.NOKTURN_API_PORT ?? 3000),
  explorer: process.env.NOKTURN_EXPLORER ?? "https://robinhoodchain.blockscout.com",
  logLevel: process.env.NOKTURN_API_LOG_LEVEL ?? "info",
  // viem's defaults are a 10 second timeout and three retries, so one hung read
  // held a request for 41 seconds, measured 21 September 2026. These bound the
  // worst case near 25 seconds. A cold fork read through a public endpoint
  // takes a few seconds, which is why the timeout is not tighter. D9.
  rpcTimeoutMs: Number(process.env.NOKTURN_API_RPC_TIMEOUT_MS ?? 8000),
  rpcRetryCount: Number(process.env.NOKTURN_API_RPC_RETRY_COUNT ?? 2),
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
export function deploymentPath(chainId: number, isFork: boolean): string {
  return isFork
    ? join(REPO_ROOT, "infra", "fork-deployment.json")
    : join(REPO_ROOT, "contracts", "deployments", `${chainId}.json`);
}

export function loadDeployment(chainId: number, isFork: boolean): Deployment {
  return readJson<Deployment>(
    deploymentPath(chainId, isFork),
    isFork ? "run make deploy against the fork first" : `no deployment recorded for chain ${chainId}`,
  );
}

/**
 * Chain 46630 carries no Stock Token, no canonical USDG and no Uniswap pool, so
 * the rehearsal fixtures stand in for all three. parameter.md section 10.6.
 * Their order matches Addresses.allowlist(), and relying on that order is why it
 * is asserted here rather than assumed. The feeds are MirrorFeed copies of the
 * mainnet Chainlink proxies and share that order.
 */
export interface TestnetFixtures {
  quote: `0x${string}`;
  tokens: `0x${string}`[];
  pools: `0x${string}`[];
  feeds: `0x${string}`[];
}

export function loadTestnetTokens(
  fixtures: TestnetFixtures = readJson<TestnetFixtures>(
    join(REPO_ROOT, "contracts", "deployments", "46630-fixtures.json"),
    "the rehearsal fixtures are not on this machine",
  ),
): ChainFile {
  // The symbols the fixture tokens answer on chain. A public testnet that said
  // NVDA beside a test token would read as the real share.
  const symbols = ["tNVDA", "tAAPL", "tTSLA", "tGOOGL", "tGME"];
  const lengths = [fixtures.tokens, fixtures.pools, fixtures.feeds ?? []].map((list) => list.length);
  if (lengths.some((n) => n !== symbols.length)) {
    throw new Error(`46630 fixtures carry ${lengths.join(", ")} tokens, pools and feeds, not five of each`);
  }
  return {
    chainId: CHAIN_ID_TESTNET,
    usdg: fixtures.quote,
    usdgDecimals: 6,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    tokens: Object.fromEntries(
      symbols.map((symbol, i) => [
        symbol,
        {token: fixtures.tokens[i]!, pool: fixtures.pools[i]!, feed: fixtures.feeds[i]!, decimals: 18},
      ]),
    ),
  };
}

/**
 * The solvers this deployment knows about.
 *
 * SolverRegistry emits SolverBonded rather than keeping a list, so the board
 * enumerates from the indexer. These are the two the demo runs, read from
 * infra/accounts.json, so a fork board has names and survives the indexer being
 * down.
 *
 * Those are local accounts, so they mean something on the fork only. On mainnet
 * or testnet only the indexer names solvers, rather than listing addresses that
 * never bonded there.
 */
export function loadKnownSolvers(isFork: boolean): {address: `0x${string}`; label: string}[] {
  if (!isFork) return [];
  const path = join(REPO_ROOT, "infra", "accounts.json");
  if (!existsSync(path)) return [];
  const accounts = JSON.parse(readFileSync(path, "utf8")) as {solverA?: string; solverB?: string};
  const out: {address: `0x${string}`; label: string}[] = [];
  if (accounts.solverA) out.push({address: accounts.solverA as `0x${string}`, label: "solver A"});
  if (accounts.solverB) out.push({address: accounts.solverB as `0x${string}`, label: "solver B"});
  return out;
}
