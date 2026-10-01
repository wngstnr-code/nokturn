// GET /v1/auctions/:auctionId
//
// Everything here is read from AuctionHouse at one block, the same block the
// provenance names. Nothing is remembered between requests, so a keeper that
// died mid cycle or an auction opened by somebody else reads the same as one
// this stack drove.

import type {FastifyInstance} from "fastify";
import type {Abi, Address} from "viem";
import type {AuctionResponse, Provenance, TokenRef} from "../../../packages/shared/api-types.ts";
import {loadAbi} from "../abi.ts";
import {chain, erc20Abi, explorerAddress, read, revertReason} from "../chain.ts";
import {badRequest, notFound} from "../errors.ts";
import {provenance, stamp, type BlockStamp} from "../provenance.ts";

export const auctionHouseAbi: Abi = loadAbi("AuctionHouse");

const WAD = 10n ** 18n;
const MAX_UINT64 = 2n ** 64n - 1n;
const KIND_CLOSE = 1;

// AuctionHouse.Phase. NONE is an id that was never opened.
const PHASE_NONE = 0;
const PHASE: Record<number, AuctionResponse["phase"]> = {
  // The contract only opens an auction inside AUCTION_OPEN or AUCTION_CLOSE and
  // publishes from the first block, so there is no stretch where commitments are
  // taken and nothing is disclosed. "accumulating" is in the frozen shape for a
  // design the contract did not adopt, and this route never answers it.
  1: "disclosing",
  2: "frozen",
  // CROSSED can still be challenged and rolled back, EXECUTED is final. Both
  // carry a price and a volume the contract has accepted.
  3: "crossed",
  4: "crossed",
  5: "aborted",
};

export interface AuctionFacts {
  token: Address;
  kind: number;
  phase: number;
  collarBps: number;
  extensions: number;
  crossAt: bigint;
  clearingPrice: bigint;
  matchedVolume: bigint;
  participants: number;
  quoteUnit: bigint;
  printMinVolume: bigint;
  printMinParticipants: number;
  indicative: {price: bigint; matched: bigint; imbalance: bigint} | null;
  committers: number;
}

/**
 * AuctionHouse prices are quote units per whole token. The response carries USD
 * at 18 decimals like every other price in this API, converted the way
 * _publishPrint converts the closing print, floored.
 */
export const toWad = (price: bigint, quoteUnit: bigint): bigint => (price * WAD) / quoteUnit;

/**
 * The same predicate _publishPrint applies, over the same quote volume
 * executeCross computes. An opening cross never prints, so it is never
 * sufficient.
 */
export function sufficient(f: AuctionFacts): boolean {
  if (f.kind !== KIND_CLOSE) return false;
  const quoteVolume = (f.matchedVolume * f.clearingPrice) / WAD;
  return quoteVolume >= f.printMinVolume && f.participants >= f.printMinParticipants;
}

export function shape(f: AuctionFacts, token: TokenRef, auctionId: bigint, prov: Provenance): AuctionResponse {
  const phase = PHASE[f.phase]!;
  const crossed = phase === "crossed";
  const live = phase === "disclosing" || phase === "frozen";
  return {
    auctionId: String(auctionId),
    token,
    kind: f.kind === KIND_CLOSE ? "close" : "open",
    phase,
    crossAt: Number(f.crossAt),
    indicativePrice: live && f.indicative ? String(toWad(f.indicative.price, f.quoteUnit)) : null,
    imbalance: live && f.indicative ? String(f.indicative.imbalance) : null,
    matchedVolume: crossed ? String(f.matchedVolume) : live && f.indicative ? String(f.indicative.matched) : null,
    participantCount: crossed ? f.participants : f.committers,
    extensions: f.extensions,
    collarBps: f.collarBps,
    result: crossed
      ? {price: String(toWad(f.clearingPrice, f.quoteUnit)), volume: String(f.matchedVolume), participants: f.participants, sufficient: sufficient(f)}
      : null,
    provenance: prov,
  };
}

async function tokenRef(address: Address, blockNumber: bigint): Promise<TokenRef> {
  const known = chain().tokens.find((t) => t.token.toLowerCase() === address.toLowerCase());
  if (known) return {address: known.token, symbol: known.symbol, decimals: known.decimals, explorerUrl: explorerAddress(known.token)};
  const [symbol, decimals] = await Promise.all([
    read<string>(address, erc20Abi, "symbol", [], blockNumber),
    read<number>(address, erc20Abi, "decimals", [], blockNumber),
  ]);
  return {address, symbol, decimals: Number(decimals), explorerUrl: explorerAddress(address)};
}

/** Null when the id was never opened. */
export async function buildAuction(auctionId: bigint, at: BlockStamp): Promise<AuctionResponse | null> {
  const house = chain().deployment.auctionHouse;
  const r = <T>(functionName: string, args: readonly unknown[] = []) => read<T>(house, auctionHouseAbi, functionName, args, at.number);

  const [token, kind, phase, , collarBps, extensions] = await r<[Address, number, number, number, number, number]>("auctionState", [auctionId]);
  if (phase === PHASE_NONE) return null;

  const [[, clearingPrice, matchedVolume, , participants], [, crossAt], quoteUnit, printMinVolume, printMinParticipants] = await Promise.all([
    r<[bigint, bigint, bigint, bigint, number, Address]>("auctionResult", [auctionId]),
    r<[bigint, bigint, bigint]>("auctionTiming", [auctionId]),
    r<bigint>("quoteUnit"),
    r<bigint>("printMinVolume"),
    r<number>("PRINT_MIN_PARTICIPANTS"),
  ]);

  let indicative: AuctionFacts["indicative"] = null;
  let committers = 0;
  if (phase === 1 || phase === 2) {
    try {
      const [price, matched, imbalance] = await r<[bigint, bigint, bigint]>("indicative", [auctionId]);
      indicative = {price, matched, imbalance};
    } catch (error) {
      // No reference price, a stale feed for instance. The contract cannot name
      // a price then, and neither does this route.
      if (revertReason(error) === null) throw error;
    }
    committers = await countCommitters(auctionId, phase === 2, r);
  }

  const facts: AuctionFacts = {
    token,
    kind: Number(kind),
    phase: Number(phase),
    collarBps: Number(collarBps),
    extensions: Number(extensions),
    crossAt,
    clearingPrice,
    matchedVolume,
    participants: Number(participants),
    quoteUnit,
    printMinVolume,
    printMinParticipants: Number(printMinParticipants),
    indicative,
    committers,
  };
  return shape(facts, await tokenRef(token, at.number), auctionId, provenance(at));
}

/** Distinct owners the contract's own _match would count, so a cancelled or unescrowed commitment is not a participant. */
async function countCommitters(auctionId: bigint, frozen: boolean, r: <T>(fn: string, args?: readonly unknown[]) => Promise<T>): Promise<number> {
  const length = await r<bigint>("bookLength", [auctionId]);
  const owners = new Set<string>();
  for (let i = 0n; i < length; i += 1n) {
    const hash = await r<`0x${string}`>("bookAt", [auctionId, i]);
    const c = await r<{owner: Address; escrowed: boolean; cancelled: boolean}>("commitment", [hash]);
    if (c.cancelled || (frozen && !c.escrowed)) continue;
    owners.add(c.owner.toLowerCase());
  }
  return owners.size;
}

export function parseAuctionId(raw: string): bigint {
  if (!/^\d{1,20}$/.test(raw) || BigInt(raw) === 0n || BigInt(raw) > MAX_UINT64) {
    throw badRequest("COORDINATOR_INVALID_REQUEST", `not an auction id: ${raw}`, {auctionId: raw});
  }
  return BigInt(raw);
}

export function auctionRoutes(app: FastifyInstance) {
  app.get<{Params: {auctionId: string}}>("/v1/auctions/:auctionId", async (request): Promise<AuctionResponse> => {
    const id = parseAuctionId(request.params.auctionId);
    const at = await stamp();
    const auction = await buildAuction(id, at);
    if (auction === null) throw notFound("COORDINATOR_INVALID_REQUEST", `no auction ${id} has been opened on AuctionHouse ${chain().deployment.auctionHouse}`);
    return auction;
  });
}
