import {cache} from "react";
import type {Address} from "viem";
import {config} from "./coordinator/client";
import {deploymentFor} from "./deployments";
import {baseTokens, quoteToken, type TokenInfo} from "./tokens";
import type {ConfigResponse, ProvenanceSource} from "./coordinator/types";
import {CHAIN_ID_TESTNET} from "@shared/addresses";

export type Network = {
  chainId: number;
  kind: ProvenanceSource["kind"];
  name: string;
  /** Said beside the name wherever a number could be mistaken for a live one. */
  note: string | null;
};

const TESTNET: Network = {
  chainId: CHAIN_ID_TESTNET,
  kind: "testnet",
  name: "Testnet",
  note: "Tokens on this chain are test tokens",
};

function describe(chainId: number, source: ProvenanceSource): Network {
  if (source.kind === "fork") {
    return {
      chainId,
      kind: "fork",
      name: "Mainnet fork",
      note: `Pinned at block ${source.pinnedBlock}. Local signers, not mainnet`,
    };
  }
  if (source.kind === "testnet") return {...TESTNET, chainId};
  return {chainId, kind: "mainnet", name: "Mainnet", note: null};
}

/*
 * Asked once per request. The header and the page both need it, and two answers
 * taken a moment apart could name two different chains on one screen.
 */
export const servedConfig = cache(async (): Promise<ConfigResponse | null> => {
  const result = await config();
  return result.ok ? result.value : null;
});

/*
 * The chain the coordinator serves, when there is one. With no coordinator the
 * app has only its own testnet record to go on, and says so.
 */
export async function activeNetwork(): Promise<Network> {
  const served = await servedConfig();
  return served === null ? TESTNET : describe(served.chainId, served.source);
}

export type Active = {
  network: Network;
  contracts: {
    settlement: Address;
    sessions: Address;
    oracle: Address;
    permit2: Address;
    auctionHouse: Address;
  };
  bases: TokenInfo[];
  quote: TokenInfo;
};

/*
 * One answer to which chain, which contracts and which tokens, for every screen.
 * Each screen used to decide for itself, and with a coordinator on a fork the
 * trade card spoke of one chain while the session screen read another.
 */
export async function active(): Promise<Active> {
  const served = await servedConfig();

  if (served !== null) {
    const named = (token: {symbol: string; address: Address; decimals: number}): TokenInfo => ({
      symbol: token.symbol,
      name: null,
      address: token.address,
      decimals: token.decimals,
    });
    const {settlement, sessions, oracle, permit2, auctionHouse} = served.contracts;
    return {
      network: describe(served.chainId, served.source),
      contracts: {settlement, sessions, oracle, permit2, auctionHouse},
      bases: served.tokens.filter((token) => token.allowed).map(named),
      quote: named(served.quoteToken),
    };
  }

  const own = deploymentFor(TESTNET.chainId);
  if (own === null) throw new Error(`Nokturn is not deployed on chain ${TESTNET.chainId}`);
  const [bases, quote] = await Promise.all([baseTokens(TESTNET.chainId), quoteToken(TESTNET.chainId)]);
  const {settlement, sessions, oracle, permit2, auctionHouse} = own;
  return {
    network: TESTNET,
    contracts: {settlement, sessions, oracle, permit2, auctionHouse},
    bases,
    quote,
  };
}
