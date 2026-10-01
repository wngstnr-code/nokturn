// What the stream announces from the chain's own logs, AuctionHouse and
// Settlement, read together in one getLogs per chunk.
//
// Solutions are announced from the log and the contract's bestSolution at that
// block. Settled and failed batches carry the same receipt GET
// /v1/batches/:batchId serves, which comes from the indexer, so they go out once
// the indexer has the batch and not before. Nothing here is remembered across a
// restart. A frame missed while the API was down is still in the receipt.

import type {FastifyBaseLogger} from "fastify";
import {hexToString, parseEventLogs, type AbiEvent, type Address, type Hex} from "viem";
import type {BatchReceipt, SolutionSummary} from "../../packages/shared/api-types.ts";
import {chain, read, settlementAbi} from "./chain.ts";
import {env} from "./config.ts";
import {publish} from "./events.ts";
import {provenance, type BlockStamp} from "./provenance.ts";
import {auctionHouseAbi, buildAuction} from "./routes/auctions.ts";
import {receiptFor} from "./routes/batches.ts";

const events = (abi: readonly unknown[], names: string[]) =>
  (abi as AbiEvent[]).filter((item) => item.type === "event" && names.includes(item.name));

// CrossExecuted rather than CrossSubmitted, because a submitted cross can still
// be challenged and rolled back, and an executed one is what paid out.
const ABI = [
  ...events(auctionHouseAbi, ["IndicativePublished", "CrossExecuted"]),
  ...events(settlementAbi, ["SolutionSubmitted", "SolutionRejected", "BatchSettled", "BatchPassthrough"]),
];

/** Bounds the log reads one tick makes after a stall. The rest waits for the next. */
const MAX_LOG_CHUNKS_PER_TICK = 20;
/**
 * Chain seconds a finished batch waits for the indexer before it is given up on,
 * and the give up is logged. The receipt route still serves it afterwards.
 */
const RECEIPT_WAIT_SECONDS = 300n;

type Decoded = {eventName: string; args: Record<string, unknown>; blockNumber: bigint | null; transactionHash: Hex | null; logIndex: number | null};

export function createAnnouncer(log: FastifyBaseLogger) {
  let from: bigint | null = null;
  const waiting = new Map<bigint, {at: bigint}>();

  async function stampOf(blockNumber: bigint, cache: Map<bigint, BlockStamp>): Promise<BlockStamp> {
    const hit = cache.get(blockNumber);
    if (hit) return hit;
    const {timestamp} = await chain().client.getBlock({blockNumber});
    const at = {number: blockNumber, timestamp};
    cache.set(blockNumber, at);
    return at;
  }

  async function summary(entry: Decoded, at: BlockStamp, rejection: string | null): Promise<SolutionSummary> {
    const a = entry.args as {batchId: bigint; solver: Address; hash: Hex; claimedSavings: bigint};
    const [bestHash] = await read<[Hex, bigint, Address]>(chain().deployment.settlement, settlementAbi, "bestSolution", [a.batchId], at.number);
    return {
      solver: a.solver,
      solutionHash: a.hash,
      claimedSavingsUsd: String(a.claimedSavings),
      accepted: rejection === null && bestHash.toLowerCase() === a.hash.toLowerCase(),
      rejectionReason: rejection,
      submittedAt: Number(at.timestamp),
      provenance: provenance(at, {transactionHash: entry.transactionHash!, logIndex: entry.logIndex!}),
    };
  }

  async function announce(logs: Decoded[]): Promise<void> {
    const stamps = new Map<bigint, BlockStamp>();
    for (const entry of logs) {
      const at = await stampOf(entry.blockNumber!, stamps);
      const T = Number(at.timestamp);
      switch (entry.eventName) {
        case "IndicativePublished":
        case "CrossExecuted": {
          const body = await buildAuction(entry.args.auctionId as bigint, at);
          if (body) publish({type: entry.eventName === "IndicativePublished" ? "auction.indicative" : "auction.crossed", at: T, data: body});
          break;
        }
        case "SolutionSubmitted": {
          // A solution refused for not being the best is still submitted, and the
          // refusal is a SolutionRejected from the same solver in the same
          // transaction. Settlement emits no event for a best that is replaced.
          const solver = String(entry.args.solver).toLowerCase();
          const refusal = logs.find(
            (l) => l.eventName === "SolutionRejected" && l.transactionHash === entry.transactionHash && String(l.args.solver).toLowerCase() === solver,
          );
          const reason = refusal ? hexToString(refusal.args.reason as Hex, {size: 32}) : null;
          const batchId = String(entry.args.batchId);
          publish({type: "batch.solution_submitted", at: T, data: {...(await summary(entry, at, null)), batchId}});
          if (reason !== null) publish({type: "batch.solution_rejected", at: T, data: {...(await summary(entry, at, reason)), batchId}});
          break;
        }
        case "SolutionRejected": {
          const paired = logs.some(
            (l) => l.eventName === "SolutionSubmitted" && l.transactionHash === entry.transactionHash && String(l.args.solver).toLowerCase() === String(entry.args.solver).toLowerCase(),
          );
          // The event carries no hash, so one without its submission cannot be
          // summarised without inventing one.
          if (!paired) log.warn({batchId: String(entry.args.batchId), tx: entry.transactionHash}, "SolutionRejected without its SolutionSubmitted, not announced");
          break;
        }
        case "BatchSettled":
        case "BatchPassthrough":
          waiting.set(entry.args.batchId as bigint, {at: at.timestamp});
          break;
      }
    }
  }

  async function deliverReceipts(now: bigint): Promise<void> {
    for (const [batchId, w] of waiting) {
      let receipt: BatchReceipt | null = null;
      try {
        receipt = (await receiptFor(batchId))?.receipt ?? null;
      } catch {
        // The database is down. The batch waits like one not indexed yet.
      }
      const done = receipt !== null && (receipt.outcome === "settled" || receipt.outcome === "passthrough" || receipt.outcome === "expired");
      if (done) {
        // The receipt's outcome names the frame, not the last log read. A batch
        // below the savings threshold emits BatchPassthrough and BatchSettled in
        // one finalize, and its receipt says settled with a failure code.
        publish({type: receipt!.outcome === "settled" ? "batch.settled" : "batch.failed", at: Number(w.at), data: receipt!});
        waiting.delete(batchId);
      } else if (now > w.at + RECEIPT_WAIT_SECONDS) {
        log.warn({batchId: String(batchId), waited: String(now - w.at)}, "batch outcome not announced, the indexer never had the batch");
        waiting.delete(batchId);
      }
    }
  }

  return {
    /** Called when chain time goes backwards. Every cursor belongs to a history the chain no longer has. */
    reset(): void {
      from = null;
      waiting.clear();
    },

    async step(at: BlockStamp): Promise<void> {
      if (from === null || from > at.number) {
        from = at.number + 1n;
      } else {
        // In chunks the endpoint accepts, a bounded number per tick, and never
        // skipping a range. The cursor moves only past what was read, so a
        // failed read is tried again on the next tick.
        const c = chain();
        for (let chunk = 0; chunk < MAX_LOG_CHUNKS_PER_TICK && from <= at.number; chunk += 1) {
          const fromBlock: bigint = from;
          const last = fromBlock + env.logBlockRange - 1n;
          const toBlock: bigint = last < at.number ? last : at.number;
          const raw = await c.client.getLogs({address: [c.deployment.auctionHouse, c.deployment.settlement], fromBlock, toBlock});
          await announce(parseEventLogs({abi: ABI, logs: raw}) as unknown as Decoded[]);
          from = toBlock + 1n;
        }
      }
      if (waiting.size) await deliverReceipts(at.timestamp);
    },
  };
}
