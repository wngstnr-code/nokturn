import {erc20Abi, getAddress, type Address} from "viem";
import {clientFor} from "./chain";
import {TESTNET_FIXTURES} from "./deployments";
import {CHAIN_ID_MAINNET, POOLS, STOCK_TOKENS, USDG, USDG_DECIMALS} from "@shared/addresses";

export type TokenInfo = {
  symbol: string;
  name: string | null;
  address: Address;
  decimals: number;
};

export type Market = {
  base: TokenInfo;
  quote: TokenInfo;
  pool: Address | null;
  fee: number | null;
};

async function describe(chainId: number, address: Address): Promise<TokenInfo | null> {
  const client = clientFor(chainId);
  try {
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({address, abi: erc20Abi, functionName: "symbol"}),
      client.readContract({address, abi: erc20Abi, functionName: "name"}).catch(() => null),
      client.readContract({address, abi: erc20Abi, functionName: "decimals"}),
    ]);
    return {symbol, name, address, decimals};
  } catch {
    return null;
  }
}

/// The quote asset on mainnet is canonical USDG at six decimals. On testnet it is
/// whichever token the fixture deploy used as the quote, and it is a test token.
export async function quoteToken(chainId: number): Promise<TokenInfo> {
  if (chainId === CHAIN_ID_MAINNET) {
    return {symbol: "USDG", name: "USDG", address: getAddress(USDG), decimals: USDG_DECIMALS};
  }
  const quote = getAddress(TESTNET_FIXTURES.quote);
  const described = await describe(chainId, quote);
  return described ?? {symbol: "tUSDG", name: null, address: quote, decimals: 6};
}

export async function baseTokens(chainId: number): Promise<TokenInfo[]> {
  if (chainId === CHAIN_ID_MAINNET) {
    const entries = Object.entries(STOCK_TOKENS) as Array<[keyof typeof STOCK_TOKENS, string]>;
    return entries.map(([symbol, address]) => ({
      symbol,
      name: null,
      address: getAddress(address),
      decimals: 18,
    }));
  }

  const described = await Promise.all(
    TESTNET_FIXTURES.tokens.map((address) => describe(chainId, getAddress(address))),
  );
  return described.filter((token): token is TokenInfo => token !== null);
}

export async function markets(chainId: number): Promise<Market[]> {
  const [bases, quote] = await Promise.all([baseTokens(chainId), quoteToken(chainId)]);

  return bases.map((base, index) => {
    if (chainId === CHAIN_ID_MAINNET) {
      const entry = POOLS[base.symbol as keyof typeof POOLS];
      return {
        base,
        quote,
        pool: entry ? getAddress(entry.pool) : null,
        fee: entry ? entry.fee : null,
      };
    }
    const pool = TESTNET_FIXTURES.pools[index];
    return {base, quote, pool: pool ? getAddress(pool) : null, fee: null};
  });
}
