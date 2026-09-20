// The one place that talks to the chain.
//
// Every route reads through this, so there is one client, one set of ABIs and
// one answer to the question of which network we are on. Routes never build a
// client of their own, because two clients means two block heights and a
// receipt that cites a block it did not read.

import {createPublicClient, http, type Abi, type Address, type PublicClient} from "viem";
import {
  CHAIN_ID_TESTNET,
  env,
  loadChainFile,
  loadDeployment,
  loadPinnedBlock,
  loadTestnetTokens,
  type ChainFile,
  type Deployment,
  type PinnedBlock,
  type TokenEntry,
} from "./config.ts";

const view = (name: string, inputs: string[], outputs: string[]) => ({
  type: "function" as const,
  name,
  stateMutability: "view" as const,
  inputs: inputs.map((type, i) => ({name: `a${i}`, type})),
  outputs: outputs.map((type) => ({type})),
});

export const settlementAbi: Abi = [
  view("batchWindow", ["uint64"], ["uint64", "uint64", "uint64"]),
  view("tokenAllowed", ["address"], ["bool"]),
  view("adapterAllowed", ["address"], ["bool"]),
  view("baselineAdapter", [], ["address"]),
  view("capPerBatchUsd", [], ["uint256"]),
  view("capPerTokenDailyUsd", [], ["uint256"]),
  view("capGlobalDailyUsd", [], ["uint256"]),
  view("isPaused", [], ["bool"]),
  view("WITNESS_TYPE_STRING", [], ["string"]),
  view("SOLUTION_WINDOW", [], ["uint32"]),
  view("FINALIZE_DEADLINE", [], ["uint32"]),
];

export const sessionAbi: Abi = [
  view("currentSession", [], ["uint8"]),
  view("sessionAt", ["uint64"], ["uint8"]),
  view("batchDuration", ["uint8"], ["uint32"]),
  view("maxDeviationBps", ["uint8"], ["uint16"]),
  view("inGuardBand", ["uint64"], ["bool"]),
  view("nextTransition", ["uint64"], ["uint64"]),
  view("tokenSession", ["address"], ["uint8"]),
];

export const oracleAbi: Abi = [
  view("refPrice", ["address"], ["uint256", "uint64", "bool"]),
  view("dualCheck", ["address"], ["uint256", "uint256", "bool"]),
  view("stalenessLimit", ["address"], ["uint32"]),
];

const error = (name: string, inputs: string[]) => ({
  type: "error" as const,
  name,
  inputs: inputs.map((type, i) => ({name: `a${i}`, type})),
});

export const adapterAbi: Abi = [
  view("quoteFromState", ["address", "address", "uint256"], ["uint256"]),
  view("quoteWithStats", ["address", "address", "uint256"], ["uint256", "uint16", "uint16"]),
  view("isQuotable", [], ["bool"]),
  // Without these the revert comes back as a bare selector and the reason a
  // baseline is unavailable is lost, which is the one thing the caller needs.
  // IVenueAdapter and UniswapV3Adapter.
  error("PoolNotSet", ["address", "address"]),
  error("PoolNotInitialized", ["address"]),
  error("TokenNotInPool", ["address", "address"]),
  error("LiquidityExhausted", ["address", "uint256"]),
  error("TooManyTickCrossings", ["address", "uint16"]),
  error("DynamicFeeUnsupported", ["address"]),
];

export const registryAbi: Abi = [
  view("isActive", ["address"], ["bool"]),
  view("bondOf", ["address"], ["uint256", "uint64"]),
  view("stats", ["address"], ["uint256", "uint256", "uint256", "uint256"]),
  view("minBond", [], ["uint256"]),
];

export const erc20Abi: Abi = [
  view("decimals", [], ["uint8"]),
  view("totalSupply", [], ["uint256"]),
  view("symbol", [], ["string"]),
];

export const multiplierAbi: Abi = [view("uiMultiplier", [], ["uint256"])];

export const permit2Abi: Abi = [view("DOMAIN_SEPARATOR", [], ["bytes32"])];

/** IntentLib.INTENT_TYPEHASH, reproduced from the string the contract hashes. */
export const INTENT_TYPE_STRING =
  "Intent(address owner,address receiver,address sellToken,address buyToken," +
  "uint256 sellAmount,uint256 minBuyAmount,uint32 validAfter,uint32 validUntil," +
  "uint8 flags,uint8 kind,uint16 maxDevFromRefBps,uint8 allowedSessions," +
  "uint16 batchSpan,uint256 nonce)";

/**
 * ERC-1967 beacon slot, and the beacon every real Stock Token shares. Reading
 * the slot rather than trusting the symbol is the whole point, because token
 * impersonation is a characteristic of this chain. CLAUDE.md section 5.
 */
export const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;
export const STOCK_TOKEN_BEACON = "0xe10b6f6b275de231345c20d14ab812db62151b00" as const;

export interface ChainContext {
  client: PublicClient;
  chainId: number;
  isFork: boolean;
  isTestnet: boolean;
  pinned: PinnedBlock | null;
  deployment: Deployment;
  quote: {address: Address; decimals: number};
  permit2: Address;
  tokens: TokenEntry[];
  explorer: string;
}

let context: ChainContext | null = null;

/**
 * Asked of the node rather than taken from a flag. A fork reports the chain id
 * of whatever it forked, so the chain id alone cannot tell the two apart, and a
 * receipt that says mainnet when it means fork is exactly the provenance
 * failure the whole schema exists to prevent.
 */
async function detectFork(client: PublicClient): Promise<boolean> {
  try {
    await client.transport.request({method: "anvil_nodeInfo", params: []});
    return true;
  } catch {
    return false;
  }
}

export async function initChain(): Promise<ChainContext> {
  if (context) return context;

  const probe = createPublicClient({transport: http(env.rpc)});
  const chainId = await probe.getChainId();
  const isFork = await detectFork(probe);
  const isTestnet = chainId === CHAIN_ID_TESTNET;

  const client = createPublicClient({
    chain: {
      id: chainId,
      name: isFork ? "robinhood-fork" : isTestnet ? "robinhood-testnet" : "robinhood",
      nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
      rpcUrls: {default: {http: [env.rpc]}},
    },
    transport: http(env.rpc),
  });

  const chainFile: ChainFile = isTestnet ? loadTestnetTokens() : loadChainFile();
  const deployment = loadDeployment(chainId, isFork);

  context = {
    client,
    chainId,
    isFork,
    isTestnet,
    pinned: isFork ? loadPinnedBlock() : null,
    deployment,
    quote: {address: chainFile.usdg, decimals: chainFile.usdgDecimals},
    permit2: chainFile.permit2,
    tokens: Object.entries(chainFile.tokens).map(([symbol, t]) => ({
      symbol,
      token: t.token,
      pool: t.pool,
      feed: t.feed && t.feed !== "0x" ? t.feed : undefined,
      decimals: t.decimals,
    })),
    explorer: env.explorer.replace(/\/$/, ""),
  };
  return context;
}

export function chain(): ChainContext {
  if (!context) throw new Error("initChain has not run");
  return context;
}

/** One typed read, so routes do not each repeat the address and abi. */
export async function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  return chain().client.readContract({address, abi, functionName, args}) as Promise<T>;
}

export function explorerAddress(address: string): string {
  return `${chain().explorer}/address/${address}`;
}
