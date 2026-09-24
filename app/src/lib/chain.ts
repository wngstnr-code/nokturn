import {createPublicClient, defineChain, http} from "viem";
import {CHAIN_ID_MAINNET, CHAIN_ID_TESTNET} from "@shared/addresses";

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
});

export const robinhoodTestnet = defineChain({
  id: CHAIN_ID_TESTNET,
  name: "Robinhood Chain Testnet",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: [rpcTestnet]}},
  blockExplorers: {
    default: {name: "Blockscout", url: "https://robinhood-testnet.cloud.blockscout.com"},
  },
});

// No JSON-RPC batching. The endpoint answers 500 to a batch the size of the
// allowlist page, and a 500 there would read as an empty beacon slot, which is a
// wrong answer rather than an error.
const transportOptions = {batch: false, timeout: 20_000, retryCount: 3, retryDelay: 250} as const;

export const mainnet = createPublicClient({
  chain: robinhoodMainnet,
  transport: http(rpcMainnet, transportOptions),
});

export const testnet = createPublicClient({
  chain: robinhoodTestnet,
  transport: http(rpcTestnet, transportOptions),
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
