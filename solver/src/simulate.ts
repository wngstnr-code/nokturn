// F20. Everything that can refuse a solution, asked before anything is sent.
//
// verify and submitSolution are asked through eth_call. The exposure caps and
// the fee cap are asked here because the contract only checks them at
// finalize, after the solver is committed. A solution that would fail there
// is slashed rather than rejected, so it is never submitted.

import {
  BaseError,
  decodeErrorResult,
  encodeAbiParameters,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {adapterAbi, oracleAbi, sessionAbi, settlementAbi, verifierAbi} from "./abi.ts";
import type {Contracts} from "./chain.ts";
import {FEE_CAP_NOTIONAL_BPS, WAD, conservation, exposureNotional, exposureViolations, feeCap, venueDeltas, type ExposureState} from "./math.ts";
import {encodeSolution, packExecutions, packIntents, type Solution} from "./solution.ts";
import type {Inputs, OracleRow} from "./solve.ts";

/** Every error a submitSolution can surface, from Settlement down to the adapter. */
function everyError(): Abi {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const abi of [settlementAbi(), verifierAbi(), adapterAbi(), oracleAbi(), sessionAbi()]) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(item);
    }
  }
  return out;
}

function revertData(error: unknown): Hex | null {
  if (!(error instanceof BaseError)) return null;
  const found = error.walk((e) => typeof (e as {data?: unknown}).data === "string" && (e as {data: string}).data.startsWith("0x")) as {data?: Hex} | null;
  return found?.data ?? null;
}

export function nameRevert(error: unknown): string {
  const data = revertData(error);
  if (!data) return (error as Error).message.split("\n")[0]!;
  try {
    const decoded = decodeErrorResult({abi: everyError(), data});
    const args = decoded.args?.map((a) => String(a)).join(", ");
    return args ? `${decoded.errorName}(${args})` : decoded.errorName;
  } catch {
    return `unknown revert ${data.slice(0, 10)}`;
  }
}

/** Solution.prices' oracle counterpart, one per token, as Settlement._verify builds it. */
export function oraclePrices(s: Solution, inputs: Inputs): bigint[] {
  return s.tokens.map((t) => (inputs.oracle.get(t.toLowerCase()) as OracleRow).price);
}

export async function verifyOnChain(c: PublicClient, k: Contracts, s: Solution, inputs: Inputs): Promise<{ok: true; savings: bigint} | {ok: false; error: string}> {
  try {
    const savings = (await c.readContract({
      address: k.verifier,
      abi: verifierAbi(),
      functionName: "verify",
      args: [
        packIntents(s.intents, s.tokens),
        packExecutions(s.executions),
        s.tokens,
        s.prices,
        venueDeltas(s.venueCalls, s.tokens),
        oraclePrices(s, inputs),
        s.baselineQuotes,
        Number(inputs.maxDeviationBps),
        Number(FEE_CAP_NOTIONAL_BPS),
      ],
      blockNumber: inputs.block,
    })) as bigint;
    return {ok: true, savings};
  } catch (error) {
    return {ok: false, error: nameRevert(error)};
  }
}

// contracts/storage-layout.txt, Settlement. today is a struct of uint32 index
// then uint256 global, which cannot share a slot, so it spans 10 and 11.
const SLOT_TODAY_INDEX = 10n;
const SLOT_TODAY_GLOBAL = 11n;
const SLOT_PER_TOKEN_ON_DAY = 12n;

const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

/**
 * Settlement's exposure state as _chargeExposure would find it on the day
 * finalize lands. today and perTokenOnDay are internal, so they are read from
 * storage at the slots the committed layout names.
 */
export async function exposureState(c: PublicClient, k: Contracts, s: Solution, finalizeAt: bigint, block: bigint): Promise<ExposureState> {
  const read = (functionName: string) => c.readContract({address: k.settlement, abi: settlementAbi(), functionName, blockNumber: block}) as Promise<bigint>;
  const slot = async (at: bigint) => BigInt((await c.getStorageAt({address: k.settlement, slot: word(at), blockNumber: block})) ?? "0x0");
  const day = finalizeAt / 86_400n;
  const [capPerBatchUsd, capPerTokenDailyUsd, capGlobalDailyUsd, todayIndex, todayGlobal] = await Promise.all([
    read("capPerBatchUsd"),
    read("capPerTokenDailyUsd"),
    read("capGlobalDailyUsd"),
    slot(SLOT_TODAY_INDEX),
    slot(SLOT_TODAY_GLOBAL),
  ]);
  const inner = keccak256(encodeAbiParameters([{type: "uint32"}, {type: "uint256"}], [Number(day), SLOT_PER_TOKEN_ON_DAY]));
  const perTokenToday = await Promise.all(
    s.tokens.map(async (t) => slot(BigInt(keccak256(encodeAbiParameters([{type: "address"}, {type: "bytes32"}], [t, inner]))))),
  );
  return {
    capPerBatchUsd,
    capPerTokenDailyUsd,
    capGlobalDailyUsd,
    globalToday: (todayIndex & 0xffffffffn) === day ? todayGlobal : 0n,
    perTokenToday,
  };
}

/**
 * Settlement._settleFees' ceiling, with minOut standing in for what the venue
 * returns. The venue can only return more, so this is the least that will be
 * withheld, and a solution over the cap here is over it on chain too.
 */
export function feeCheck(s: Solution): {withheldUsd: bigint; cap: bigint; ok: boolean} {
  const surplus = conservation(s);
  const withheldUsd = surplus.reduce((sum, amount, t) => sum + (amount > 0n ? (amount * s.prices[t]!) / WAD : 0n), 0n);
  const cap = feeCap(s.claimedSavings + withheldUsd, exposureNotional(s).notionalUsd);
  return {withheldUsd, cap, ok: withheldUsd <= cap};
}

export interface Preflight {
  exposure: string[];
  fee: {withheldUsd: bigint; cap: bigint; ok: boolean};
}

export async function preflight(c: PublicClient, k: Contracts, s: Solution, inputs: Inputs, finalizeAt: bigint): Promise<Preflight> {
  const state = await exposureState(c, k, s, finalizeAt, inputs.block);
  return {exposure: exposureViolations(exposureNotional(s), inputs.session, state), fee: feeCheck(s)};
}

/** submitSolution through eth_call from the solver's own address, on the newest block. */
export async function simulateSubmit(c: PublicClient, k: Contracts, s: Solution, from: Address): Promise<{ok: true} | {ok: false; error: string}> {
  try {
    await c.call({account: from, to: k.settlement, data: encodeSolution(s)});
    return {ok: true};
  } catch (error) {
    return {ok: false, error: nameRevert(error)};
  }
}
