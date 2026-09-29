// The intent mempool. In memory, lost on restart, and that is exactly why the
// escape hatch exists (docs/spek-teknis.md section 9.3). This module never
// claims a persistence it does not have.

import type {ApiError, IntentStatus, SignedIntent} from "../../packages/shared/api-types.ts";
import {NO_ORDINARY_BATCH, isBatch, nextValidBatchId, type BatchLookup} from "../../packages/shared/batch.ts";
import {createChainReader} from "../../packages/shared/batch-viem.ts";
import {chain} from "./chain.ts";
import {fail} from "./errors.ts";
import type {BlockStamp} from "./provenance.ts";
import type {Withdrawal} from "./revalidate.ts";

/**
 * Settlement.SOLUTION_WINDOW and Settlement.FINALIZE_DEADLINE, parameter.md
 * section 6. Used only to decide when a batch is done enough to forget, never
 * to validate anything the contract itself checks.
 */
const SOLUTION_WINDOW = 10n;
export const FINALIZE_DEADLINE = 300n;

/**
 * How long, in chain seconds past its batch's finalize deadline, an intent's
 * status stays answerable. byHash used to keep every intent ever accepted, about
 * 10.6 KB each, so an API left running for a long demo only ever grew. D6.
 * After this a status lookup answers 404, and the receipt, which the indexer
 * keeps, is where the outcome lives. Settable so the C1-7 torture case can
 * watch a steady state inside one run.
 */
export const STATUS_RETENTION = BigInt(process.env.NOKTURN_API_STATUS_RETENTION_SECONDS || 86_400);

export interface StoredIntent {
  batchId: bigint;
  signed: SignedIntent;
  status: IntentStatus;
  rejection: ApiError | null;
}

const byBatch = new Map<bigint, SignedIntent[]>();
const byHash = new Map<string, StoredIntent>();
/**
 * The feed of a frozen batch, screened once and then served unchanged, so every
 * solver builds on the same set no matter when it asks. F10.
 */
const frozenFeeds = new Map<bigint, Promise<SignedIntent[]>>();
const withdrawnByBatch = new Map<bigint, Withdrawal[]>();
/** Carries its own validUntil, so a nonce stays held after its status entry is forgotten. D5, D6. */
const byOwnerNonce = new Map<string, {intentHash: string; validUntil: bigint}>();

// Keyed on the nonce's value rather than on how the client spelled it. "7",
// "07" and "0x7" are one Permit2 nonce, and only one of them can ever settle.
function ownerNonceKey(owner: string, nonce: string): string {
  return `${owner.toLowerCase()}:${BigInt(nonce)}`;
}

/**
 * Forgets batches whose finalize deadline has passed. Intents from a forgotten
 * batch stay in byHash marked expired instead of disappearing, so a status
 * lookup never turns into a 404 for something that really was accepted once.
 *
 * Exported because a status lookup has to run it as well. Called only from
 * openWindow, a quiet coordinator reported an intent pending for as long
 * as nobody asked for the current batch. C1-8.
 */
export function sweep(now: bigint): void {
  for (const [batchId, list] of byBatch) {
    if (now <= batchId + SOLUTION_WINDOW + FINALIZE_DEADLINE) continue;
    byBatch.delete(batchId);
    frozenFeeds.delete(batchId);
    withdrawnByBatch.delete(batchId);
    for (const signed of list) {
      const stored = byHash.get(signed.intentHash);
      if (stored && stored.status === "pending") stored.status = "expired";
    }
  }

  // A nonce is held for as long as its signature could still settle, which
  // ends where Permit2 refuses it, block.timestamp past the deadline, and the
  // deadline is validUntil. Releasing it with the batch instead would let a
  // second intent reuse a nonce the first can still spend. D5.
  for (const [key, held] of byOwnerNonce) {
    if (now > held.validUntil) byOwnerNonce.delete(key);
  }

  // The status entry goes a retention after its batch closed. Its nonce does
  // not go with it, byOwnerNonce keeps that until validUntil. D6.
  for (const [intentHash, stored] of byHash) {
    if (now > stored.batchId + SOLUTION_WINDOW + FINALIZE_DEADLINE + STATUS_RETENTION) byHash.delete(intentHash);
  }
}

/** How many intents the mempool still remembers, for health and for the D6 test. */
export function remembered(): number {
  return byHash.size;
}

/** Nonces this owner's accepted intents still hold. Accurate as of the last sweep. */
export function heldNonces(owner: string): Set<bigint> {
  const prefix = `${owner.toLowerCase()}:`;
  const held = new Set<bigint>();
  for (const key of byOwnerNonce.keys()) {
    if (key.startsWith(prefix)) held.add(BigInt(key.slice(prefix.length)));
  }
  return held;
}

/**
 * The batch a new intent joins, the one GET /v1/batches/current reports, and
 * the one the lifecycle opens. All three call this single function so they are
 * structurally unable to name a different batch for the same moment.
 *
 * nextValidBatchId walks past an auction phase to the first batch after it,
 * which is right for a solver planning ahead and wrong here. An intent taken
 * during an auction would wait out the whole phase in a batch nobody can see
 * yet, while the route that reports the current batch said a different thing.
 * So an auction phase, or a batch that only starts after one, is no batch. N4.
 */
export async function openWindow(at: BlockStamp): Promise<BatchLookup> {
  const c = chain();
  const reader = createChainReader(c.client, c.deployment.sessions);
  sweep(at.timestamp);

  const auction: BatchLookup = {batchId: null, reason: "auction_phase", retryAt: null};
  if ((await reader.batchDuration(await reader.sessionAt(at.timestamp))) === NO_ORDINARY_BATCH) return auction;

  const lookup = await nextValidBatchId(reader, at.timestamp);
  if (!isBatch(lookup)) return lookup;

  // The last seconds of OPEN, where every batch left sits in the guard band
  // and the search lands in POST_MARKET. Bounded like the search itself.
  let t = at.timestamp;
  for (let step = 0; step < 4; step += 1) {
    const next = await reader.nextTransition(t);
    if (next <= t || next >= lookup.batchId) break;
    if ((await reader.batchDuration(await reader.sessionAt(next))) === NO_ORDINARY_BATCH) return auction;
    t = next;
  }
  return lookup;
}

/** Throws COORDINATOR_DUPLICATE_INTENT, 409, on a repeat hash or owner/nonce. */
export function admit(intentHash: string, signed: SignedIntent, batchId: bigint): void {
  if (byHash.has(intentHash)) {
    throw fail(409, "COORDINATOR_DUPLICATE_INTENT", `intent ${intentHash} was already accepted`, {intentHash});
  }
  const key = ownerNonceKey(signed.intent.owner, signed.intent.nonce);
  const dup = byOwnerNonce.get(key);
  if (dup) {
    throw fail(
      409,
      "COORDINATOR_DUPLICATE_INTENT",
      `owner ${signed.intent.owner} already used nonce ${signed.intent.nonce} on intent ${dup.intentHash}`,
      {intentHash: dup.intentHash},
    );
  }

  byOwnerNonce.set(key, {intentHash, validUntil: BigInt(signed.intent.validUntil)});
  byHash.set(intentHash, {batchId, signed, status: "pending", rejection: null});
  const list = byBatch.get(batchId);
  if (list) list.push(signed);
  else byBatch.set(batchId, [signed]);
}

/**
 * Takes an intent out of its batch because it can no longer be collected. Its
 * nonce is released, since the coordinator will not relay this signature again
 * and the owner may want to sign a funded replacement with the same nonce.
 */
export function withdraw(intentHash: string, rejection: ApiError): void {
  const stored = byHash.get(intentHash);
  if (!stored || stored.status !== "pending") return;
  stored.status = "rejected";
  stored.rejection = rejection;
  const list = byBatch.get(stored.batchId);
  if (list) {
    const i = list.findIndex((s) => s.intentHash === intentHash);
    if (i >= 0) list.splice(i, 1);
  }
  const gone = withdrawnByBatch.get(stored.batchId) ?? [];
  gone.push({intentHash: stored.signed.intentHash, owner: stored.signed.intent.owner, rejection});
  withdrawnByBatch.set(stored.batchId, gone);
  const k = ownerNonceKey(stored.signed.intent.owner, stored.signed.intent.nonce);
  if (byOwnerNonce.get(k)?.intentHash === intentHash) byOwnerNonce.delete(k);
}

/**
 * Pending intents of this owner selling this token, in batches the mempool
 * still holds. Each can still be pulled until its batch is finalized or its
 * deadline passes, so each still has a claim on the owner's balance. D4.
 */
export function committed(owner: string, sellToken: string): {signed: SignedIntent; batchId: bigint}[] {
  const out: {signed: SignedIntent; batchId: bigint}[] = [];
  for (const [batchId, list] of byBatch) {
    for (const signed of list) {
      if (signed.intent.owner.toLowerCase() !== owner.toLowerCase()) continue;
      if (signed.intent.sellToken.toLowerCase() !== sellToken.toLowerCase()) continue;
      if (byHash.get(signed.intentHash)?.status === "pending") out.push({signed, batchId});
    }
  }
  return out;
}

export function withdrawnFrom(batchId: bigint): Withdrawal[] {
  return withdrawnByBatch.get(batchId) ?? [];
}

/**
 * The frozen feed for a batch, built once. A promise rather than a result, so
 * two solvers asking in the same instant share one screening instead of racing
 * two, where the second would see a set the first had already cut. A failed
 * build is forgotten so the next request tries again.
 */
export function frozenFeed(batchId: bigint, build: () => Promise<SignedIntent[]>): Promise<SignedIntent[]> {
  let feed = frozenFeeds.get(batchId);
  if (!feed) {
    feed = build().catch((error) => {
      frozenFeeds.delete(batchId);
      throw error;
    });
    frozenFeeds.set(batchId, feed);
  }
  return feed;
}

export function getByHash(intentHash: string): StoredIntent | null {
  return byHash.get(intentHash) ?? null;
}

export function getByBatch(batchId: bigint): SignedIntent[] {
  return byBatch.get(batchId) ?? [];
}

/** intentCount is every intent seen for the batch, participantCount counts unique owners. */
export function counts(batchId: bigint): {intentCount: number; participantCount: number} {
  const list = getByBatch(batchId);
  const owners = new Set(list.map((s) => s.intent.owner.toLowerCase()));
  return {intentCount: list.length, participantCount: owners.size};
}
