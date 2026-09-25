import {createPublicClient, defineChain} from "viem";
import {resilientHttp} from "./transport";
import {CHAIN_ID_MAINNET, CHAIN_ID_TESTNET} from "@shared/addresses";

/// Verified present on 46630 at the address it carries on every other chain.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const rpcMainnet = process.env.NOKTURN_RPC_MAINNET ?? "https://robinhood.drpc.org";
const rpcTestnet = process.env.NOKTURN_RPC_TESTNET ?? "https://robinhood-testnet.drpc.org";

export const robinhoodMainnet = defineChain({
  id: CHAIN_ID_MAINNET,
  name: "Robinhood Chain",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: [rpcMainnet]}},
  blockExplorers: {
    default: {name: "Blockscout", url: "https://robinhood.cloud.blockscout.com"},
  },
  contracts: {multicall3: {address: MULTICALL3}},
});

export const robinhoodTestnet = defineChain({
  id: CHAIN_ID_TESTNET,
  name: "Robinhood Chain Testnet",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: [rpcTestnet]}},
  blockExplorers: {
    default: {name: "Blockscout", url: "https://robinhood-testnet.cloud.blockscout.com"},
  },
  contracts: {multicall3: {address: MULTICALL3}},
});

// No JSON-RPC batching. The endpoint answers 500 to a batch the size of the
// allowlist page, and a 500 there would read as an empty beacon slot, which is a
// wrong answer rather than an error.
const transportOptions = {batch: false, timeout: 20_000, retryCount: 3, retryDelay: 250} as const;

/*
 * Multicall is not that batching. It is one eth_call to Multicall3, so the
 * endpoint sees a single request rather than a protocol batch it refuses. The
 * session screen made twenty six separate reads and met the public rate limit
 * most of the time, and viem groups these by block so the pinned reads still
 * land on one block.
 */
const clientOptions = {batch: {multicall: {wait: 12}}} as const;

export const mainnet = createPublicClient({
  chain: robinhoodMainnet,
  transport: resilientHttp(rpcMainnet, transportOptions),
  ...clientOptions,
});

export const testnet = createPublicClient({
  chain: robinhoodTestnet,
  transport: resilientHttp(rpcTestnet, transportOptions),
  ...clientOptions,
});

export function clientFor(chainId: number): typeof mainnet | typeof testnet {
  return chainId === CHAIN_ID_MAINNET ? mainnet : testnet;
}

export function chainFor(chainId: number): typeof robinhoodMainnet | typeof robinhoodTestnet {
  return chainId === CHAIN_ID_MAINNET ? robinhoodMainnet : robinhoodTestnet;
}

export function explorerAddress(address: string, chainId: number = CHAIN_ID_MAINNET): string {
  return `${chainFor(chainId).blockExplorers.default.url}/address/${address}`;
}

export function explorerTx(hash: string, chainId: number = CHAIN_ID_MAINNET): string {
  return `${chainFor(chainId).blockExplorers.default.url}/tx/${hash}`;
}
