import {erc20Abi, getAddress, parseAbi, size, type Address} from "viem";
import {mainnet, robinhoodMainnet} from "./chain";
import {BEACON_SLOT, STOCK_TOKENS, STOCK_TOKEN_BEACON} from "@shared/addresses";

const uiMultiplierAbi = parseAbi(["function uiMultiplier() view returns (uint256)"]);

const ONE = 10n ** 18n;

export const IMPOSTOR_GME =
  "0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba3" as const satisfies Address;

/// A read that failed is not a read that came back empty. Collapsing the two would
/// let a flaky endpoint accuse a real Stock Token of being an impostor, which is a
/// wrong answer wearing the costume of a right one.
type Outcome<T> =
  | {kind: "value"; value: T}
  | {kind: "revert"; name: string}
  | {kind: "unreadable"; detail: string};

export type CheckState = "pass" | "fail" | "unknown";

export type Check = {
  id: string;
  label: string;
  state: CheckState;
  reading: string;
  expected: string;
};

export type TokenReport = {
  listed: boolean;
  requested: string;
  address: Address;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
  codeBytes: number | null;
  beacon: Address | null;
  uiMultiplier: bigint | null;
  checks: Check[];
  verdict: "admitted" | "rejected" | "unknown";
};

export type GateReport = {
  blockNumber: bigint;
  readAt: string;
  chainId: number;
  reports: TokenReport[];
};

function revertName(thrown: unknown): string | null {
  const seen = new Set<unknown>();
  let cursor: unknown = thrown;
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const node = cursor as {data?: {errorName?: string}; name?: string; cause?: unknown};
    if (typeof node.data?.errorName === "string") return node.data.errorName;
    if (node.name === "ContractFunctionRevertedError") return "reverted";
    cursor = node.cause;
  }
  return null;
}

function isRevert(thrown: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = thrown;
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const name = (cursor as {name?: string}).name;
    if (name === "ContractFunctionRevertedError") return true;
    if (name === "HttpRequestError" || name === "TimeoutError") return false;
    cursor = (cursor as {cause?: unknown}).cause;
  }
  return false;
}

async function attempt<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return {kind: "value", value: await work};
  } catch (thrown) {
    if (isRevert(thrown)) {
      return {kind: "revert", name: revertName(thrown) ?? "reverted"};
    }
    const short = (thrown as {shortMessage?: string}).shortMessage;
    return {
      kind: "unreadable",
      detail: short ?? (thrown instanceof Error ? thrown.message.slice(0, 90) : "endpoint did not answer"),
    };
  }
}

function valueOf<T>(outcome: Outcome<T>): T | null {
  return outcome.kind === "value" ? outcome.value : null;
}

function beaconFromSlot(word: `0x${string}` | undefined): Address | null {
  if (!word || word.length < 42) return null;
  const tail = `0x${word.slice(-40)}` as Address;
  if (/^0x0+$/.test(tail)) return null;
  return getAddress(tail);
}

async function inspect(
  requested: string,
  address: Address,
  listed: boolean,
  blockNumber: bigint,
): Promise<TokenReport> {
  const at = {blockNumber} as const;

  const [code, slot, name, symbol, decimals, totalSupply, uiMultiplier] = await Promise.all([
    attempt(mainnet.getCode({address, ...at})),
    attempt(mainnet.getStorageAt({address, slot: BEACON_SLOT, ...at})),
    attempt(mainnet.readContract({address, abi: erc20Abi, functionName: "name", ...at})),
    attempt(mainnet.readContract({address, abi: erc20Abi, functionName: "symbol", ...at})),
    attempt(mainnet.readContract({address, abi: erc20Abi, functionName: "decimals", ...at})),
    attempt(mainnet.readContract({address, abi: erc20Abi, functionName: "totalSupply", ...at})),
    attempt(mainnet.readContract({address, abi: uiMultiplierAbi, functionName: "uiMultiplier", ...at})),
  ]);

  const expectedBeacon = getAddress(STOCK_TOKEN_BEACON);
  const beacon = slot.kind === "value" ? beaconFromSlot(slot.value ?? undefined) : null;

  const beaconCheck: Check =
    slot.kind === "unreadable"
      ? {
          id: "beacon",
          label: "ERC-1967 beacon slot",
          state: "unknown",
          reading: slot.detail,
          expected: expectedBeacon,
        }
      : {
          id: "beacon",
          label: "ERC-1967 beacon slot",
          state: beacon !== null && beacon === expectedBeacon ? "pass" : "fail",
          reading: beacon ?? "empty",
          expected: expectedBeacon,
        };

  const multiplierCheck: Check =
    uiMultiplier.kind === "unreadable"
      ? {
          id: "multiplier",
          label: "uiMultiplier()",
          state: "unknown",
          reading: uiMultiplier.detail,
          expected: `at least ${ONE.toString()}`,
        }
      : {
          id: "multiplier",
          label: "uiMultiplier()",
          state:
            uiMultiplier.kind === "value" && uiMultiplier.value >= ONE ? "pass" : "fail",
          reading:
            uiMultiplier.kind === "value" ? uiMultiplier.value.toString() : "no such function",
          expected: `at least ${ONE.toString()}`,
        };

  const checks = [beaconCheck, multiplierCheck];
  const verdict = checks.some((check) => check.state === "unknown")
    ? "unknown"
    : checks.every((check) => check.state === "pass")
      ? "admitted"
      : "rejected";

  const codeValue = valueOf(code);

  return {
    listed,
    requested,
    address,
    name: valueOf(name),
    symbol: valueOf(symbol),
    decimals: valueOf(decimals),
    totalSupply: valueOf(totalSupply),
    codeBytes: code.kind === "value" ? (codeValue ? size(codeValue) : 0) : null,
    beacon,
    uiMultiplier: valueOf(uiMultiplier),
    checks,
    verdict,
  };
}

export async function runGate(): Promise<GateReport> {
  const blockNumber = await mainnet.getBlockNumber();

  const subjects: Array<{requested: string; address: Address; listed: boolean}> = [
    ...Object.entries(STOCK_TOKENS).map(([symbol, address]) => ({
      requested: symbol,
      address: getAddress(address),
      listed: true,
    })),
    {requested: "GME", address: getAddress(IMPOSTOR_GME), listed: false},
  ];

  // Sequential on purpose. The endpoint answers 500 once enough reads land at once,
  // and a dropped read here is the one failure this screen must never have.
  const reports: TokenReport[] = [];
  for (const subject of subjects) {
    reports.push(await inspect(subject.requested, subject.address, subject.listed, blockNumber));
  }

  return {
    blockNumber,
    readAt: new Date().toISOString(),
    chainId: robinhoodMainnet.id,
    reports,
  };
}
