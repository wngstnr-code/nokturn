import {cache} from "react";
import {config} from "./coordinator/client";
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
