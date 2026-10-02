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
  fallback,
  http,
  type Abi,
  type Address,
  type PublicClient,
  type Transport,
} from "viem";
import {carriesPath, redactUrl, unknownMethod} from "../../packages/shared/rpc.ts";
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
/** The canonical Multicall3, deployed at the same address on mainnet 4663. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

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

// F6. Which endpoint last answered, and how many requests went out in the last
// minute. Logged on every change of endpoint and once a minute over budget.
let serving: number | null = null;
const lastMinute: number[] = [];
let budgetWarnedAt = 0;
let rpcLog: {info: (o: object, m: string) => void; warn: (o: object, m: string) => void} = {info: () => {}, warn: () => {}};

export function useRpcLog(log: typeof rpcLog): void {
  rpcLog = log;
}

export interface RpcStatus {
  endpoint: string | null;
  primary: boolean;
  requestsLastMinute: number;
  overBudget: boolean;
}

export function rpcStatus(): RpcStatus {
  prune(Date.now());
  return {endpoint: serving === null ? null : redactUrl(env.rpcs[serving]!), primary: serving === null || serving === 0, requestsLastMinute: lastMinute.length, overBudget: lastMinute.length > env.rpcBudgetPerMinute};
}

function prune(now: number): void {
  while (lastMinute.length && lastMinute[0]! < now - 60_000) lastMinute.shift();
}

function counted(): void {
  const now = Date.now();
  requests += 1;
  lastMinute.push(now);
  prune(now);
  if (lastMinute.length > env.rpcBudgetPerMinute && now - budgetWarnedAt > 60_000) {
    budgetWarnedAt = now;
    rpcLog.warn({requestsLastMinute: lastMinute.length, budget: env.rpcBudgetPerMinute}, "rpc request budget exceeded");
  }
}

function answeredBy(index: number): void {
  if (serving === index) return;
  const from = serving;
  serving = index;
  const note = {endpoint: redactUrl(env.rpcs[index]!), position: index, of: env.rpcs.length};
  if (from === null) rpcLog.info(note, "rpc endpoint in use");
  else rpcLog.warn({...note, from: redactUrl(env.rpcs[from]!)}, index === 0 ? "rpc back on the primary endpoint" : "rpc failed over to a fallback endpoint");
}

// How long each request to the node took, summarised once a minute. On
// 2 October 2026 every route that touched the node took 3 to 11 seconds on
// Railway while the same calls took about 300 ms from a laptop, and nothing in
// the logs said whether the node was slow or the API was queueing on it.
let timings: {ms: number; method: string}[] = [];
let timingsSince = Date.now();

function recordTiming(ms: number, method: string): void {
  timings.push({ms, method});
  const now = Date.now();
  if (now - timingsSince < 60_000) return;
  const sorted = timings.map((t) => t.ms).sort((a, b) => a - b);
  const at = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0);
  const methods: Record<string, number> = {};
  for (const t of timings) methods[t.method] = (methods[t.method] ?? 0) + 1;
  rpcLog.info({requests: timings.length, p50: at(0.5), p95: at(0.95), max: at(1), methods}, "rpc latency over the last minute");
  timings = [];
  timingsSince = now;
}

function timed(inner: Transport): Transport {
  return (options) => {
    const t = inner(options);
    return {
      ...t,
      request: (async (args: {method: string}) => {
        const start = performance.now();
        try {
          return await t.request(args as never);
        } finally {
          recordTiming(performance.now() - start, args.method);
        }
      }) as typeof t.request,
    };
  };
}

/** One http transport per endpoint. More than one becomes a fallback, tried in the listed order. */
function transport(): Transport {
  const each = env.rpcs.map((url, i) =>
    http(url, {
      timeout: env.rpcTimeoutMs,
      retryCount: env.rpcs.length > 1 ? 0 : env.rpcRetryCount,
      onFetchRequest: counted,
      onFetchResponse: (response) => {
        if (response.ok) answeredBy(i);
      },
    }),
  );
  return timed(each.length === 1 ? each[0]! : fallback(each, {rank: false, retryCount: env.rpcRetryCount}));
}

/**
 * Asked of the node rather than taken from a flag. A fork reports the chain id
 * of whatever it forked, so the chain id alone cannot tell the two apart, and a
 * receipt that says mainnet when it means fork is exactly the provenance
 * failure the whole schema exists to prevent. Only a node that says it does
 * not know the method counts as not a fork. A dropped request is retried and
 * then thrown, never read as an answer.
 */
async function detectFork(client: PublicClient): Promise<{forkBlockNumber: number} | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const info = (await client.request({method: "anvil_nodeInfo" as never, params: [] as never})) as {forkConfig?: {forkBlockNumber?: number}};
      return {forkBlockNumber: Number(info.forkConfig?.forkBlockNumber ?? 0)};
    } catch (error) {
      if (unknownMethod(error)) return null;
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    }
  }
}

/**
 * The block the running fork actually forked from, asked of the node. The file
 * make pin writes names only the batch fork, and make keeper-fork stands 1.3
 * million blocks earlier, so every receipt from it cited a block it never read.
 */
async function forkPoint(client: PublicClient, chainId: number, block: number): Promise<PinnedBlock | null> {
  const file = loadPinnedBlock();
  // Zero is a node that did not say, not a fork of genesis.
  if (block === 0 || (file && file.block === block)) return file;
  const {timestamp} = await client.getBlock({blockNumber: BigInt(block)});
  return {chainId, block, timestamp: Number(timestamp), timestampUtc: new Date(Number(timestamp) * 1000).toISOString()};
}

export async function initChain(): Promise<ChainContext> {
  if (context) return context;

  if (env.publicRpc === env.rpc && carriesPath(env.rpc)) {
    throw new Error(
      `NOKTURN_API_RPC looks like a paid endpoint, ${redactUrl(env.rpc)}, and it would be printed in every cast command a receipt carries. Set NOKTURN_API_PUBLIC_RPC to the url a judge should use, for example https://rpc.mainnet.chain.robinhood.com`,
    );
  }

  // No block number cache. Its four seconds outlive an evm_revert on the fork,
  // and a head that old points at blocks that no longer exist.
  const probe = createPublicClient({cacheTime: 0, transport: transport()});
  const chainId = await probe.getChainId();
  const fork = await detectFork(probe);
  const isFork = fork !== null;
  const isTestnet = chainId === CHAIN_ID_TESTNET;

  // Reads issued in the same tick go out as one Multicall3 call where the chain
  // has it. Against mainnet on Alchemy's free tier the idle API sent 1052
  // requests a minute and was answered 429, measured 1 October 2026.
  const multicall = ((await probe.getCode({address: MULTICALL3})) ?? "0x").length > 2;
  const client = createPublicClient({
    cacheTime: 0,
    batch: multicall ? {multicall: true} : undefined,
    chain: {
      id: chainId,
      name: isFork ? "robinhood-fork" : isTestnet ? "robinhood-testnet" : "robinhood",
      nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
      rpcUrls: {default: {http: [env.publicRpc]}},
      contracts: multicall ? {multicall3: {address: MULTICALL3}} : undefined,
    },
    transport: transport(),
  });

  const chainFile: ChainFile = isTestnet ? loadTestnetTokens() : loadChainFile();
  const deployment = loadDeployment(chainId, isFork);

  context = {
    client,
    chainId,
    isFork,
    isTestnet,
    pinned: fork ? await forkPoint(probe, chainId, fork.forkBlockNumber) : null,
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
