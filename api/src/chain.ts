// The one place that talks to the chain.
//
// Every route reads through this, so there is one client, one set of ABIs and
// one answer to the question of which network we are on. Routes never build a
// client of their own, because two clients means two block heights and a
// receipt that cites a block it did not read.

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import {erc20Abi, invalidateNoncesAbi, loadAbi} from "./abi.ts";
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

export const settlementAbi: Abi = loadAbi("Settlement");
export const sessionAbi: Abi = loadAbi("SessionManager");
export const oracleAbi: Abi = loadAbi("PriceOracle");
export const adapterAbi: Abi = loadAbi("UniswapV3Adapter");
export const registryAbi: Abi = loadAbi("SolverRegistry");
export const multiplierAbi: Abi = loadAbi("IUiMultiplier");
export const mandateAbi: Abi = loadAbi("MandateAccount");

export {erc20Abi, invalidateNoncesAbi};

/**
 * The deployed Permit2 plus the one function IPermit2.sol does not declare.
 * Cancelling is a user action rather than a protocol one, so Settlement never
 * calls invalidateUnorderedNonces and the interface has no reason to carry it.
 */
export const permit2Abi: Abi = [...loadAbi("ISignatureTransfer"), ...invalidateNoncesAbi];

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
let requests = 0;

/** Requests sent to the node since boot, so a caller can log what one step cost. */
export function rpcRequestCount(): number {
  return requests;
}

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
    transport: http(env.rpc, {
      timeout: env.rpcTimeoutMs,
      retryCount: env.rpcRetryCount,
      onFetchRequest: () => {
        requests += 1;
      },
    }),
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

/**
 * Whether the deployment record on disk still names the contracts this process
 * booted with. A redeploy under a running API left it holding the old
 * Settlement, so a signature that was valid for the new one came back
 * COORDINATOR_BAD_SIGNATURE and the caller was told their key was wrong. D12.
 */
export function deploymentMoved(): boolean {
  const c = chain();
  let onDisk: string;
  try {
    onDisk = JSON.stringify(loadDeployment(c.chainId, c.isFork));
  } catch {
    return true;
  }
  return onDisk !== JSON.stringify(c.deployment);
}

/**
 * One typed read, so routes do not each repeat the address and abi. A route that
 * publishes a block in its provenance passes that block here, or its reads land
 * on whatever block is newest when each one arrives. D8.
 */
export async function read<T>(
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
  blockNumber?: bigint,
) {
  return chain().client.readContract({address, abi, functionName, args, blockNumber}) as Promise<T>;
}

/**
 * The contract's own name for a revert, or null when the failure was not a
 * revert at all. A revert is an answer from the chain and a route can report
 * it. Anything else is the node, and belongs in a 502.
 */
export function revertReason(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  return reverted.data?.errorName ?? reverted.reason ?? reverted.signature ?? "reverted";
}

export function explorerAddress(address: string): string {
  return `${chain().explorer}/address/${address}`;
}
