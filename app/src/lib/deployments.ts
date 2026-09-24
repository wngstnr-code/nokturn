import type {Address} from "viem";
import testnet from "../../../contracts/deployments/46630.json";
import fixtures from "../../../contracts/deployments/46630-fixtures.json";
import {CHAIN_ID_TESTNET} from "@shared/addresses";

export type Deployment = {
  settlement: Address;
  sessions: Address;
  auctionHouse: Address;
  oracle: Address;
  solvers: Address;
  mandates: Address;
  adapter: Address;
  verifier: Address;
  timelock: Address;
  guardian: Address;
  treasury: Address;
  usdg: Address;
  permit2: Address;
};

export const TESTNET_DEPLOYMENT = testnet as Deployment;

export const TESTNET_FIXTURES = fixtures as {pools: Address[]; quote: Address; tokens: Address[]};

/// Mainnet 4663 has nothing deployed yet. Reading a missing deployment must fail
/// loudly rather than fall back to the testnet addresses, because a screen that
/// silently shows testnet numbers under a mainnet label is the exact failure the
/// no mock rule exists to prevent.
export const DEPLOYMENTS: Partial<Record<number, Deployment>> = {
  [CHAIN_ID_TESTNET]: TESTNET_DEPLOYMENT,
};

export function deploymentFor(chainId: number): Deployment | null {
  return DEPLOYMENTS[chainId] ?? null;
}
