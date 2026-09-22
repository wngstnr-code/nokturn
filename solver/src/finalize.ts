// F21, the finalize half. A batch this solver won is finalized after solveEnd
// and before solveEnd + FINALIZE_DEADLINE, from the bytes the store kept.
//
// Every wait is on blocks, never on the laptop clock, and every batch has a hard
// deadline after which it is let go with the reason written down. A revert is
// named and tried once more on the next block, only in case it was transient.

import {encodeFunctionData, parseEventLogs, type Address, type Hex, type PublicClient} from "viem";
import type {HDAccount} from "viem/accounts";
import {settlementAbi} from "./abi.ts";
import type {Contracts} from "./chain.ts";
import {FINALIZE_DEADLINE, SOLUTION_WINDOW, replayRevert, sendToSettlement} from "./send.ts";
import {nameRevert} from "./simulate.ts";
import type {Solution} from "./solution.ts";
import type {Status, Store} from "./store.ts";

export interface FinalizeOutcome {
  status: Extract<Status, "not_best" | "finalized" | "finalized_by_other" | "finalize_reverted" | "abandoned">;
  tx: Hex | null;
  block: bigint | null;
  /** BatchSettled, or the BatchPassthrough reason, or why nothing was sent. */
  result: string;
  intentsSettled: number;
  savingsUsd: bigint;
}

/**
 * Resolves with the first block whose timestamp passes the predicate, or null
 * once one passes the deadline instead. Driven by viem's block watcher.
 */
export function untilBlock(c: PublicClient, until: (ts: bigint) => boolean, deadline: bigint): Promise<{number: bigint; timestamp: bigint} | null> {
  return new Promise((resolve, reject) => {
    const unwatch = c.watchBlocks({
      emitOnBegin: true,
      pollingInterval: 250,
      onBlock: (b) => {
        if (b.timestamp > deadline) {
          unwatch();
          resolve(null);
        } else if (until(b.timestamp)) {
          unwatch();
          resolve({number: b.number!, timestamp: b.timestamp});
        }
      },
      onError: (error) => {
        unwatch();
        reject(error);
      },
    });
  });
}

function finalizeData(s: Solution): Hex {
  return encodeFunctionData({abi: settlementAbi(), functionName: "finalize", args: [s.batchId, s]});
}

async function tryFinalize(c: PublicClient, account: HDAccount, k: Contracts, s: Solution): Promise<{ok: true; tx: Hex; block: bigint; result: string; intentsSettled: number; savingsUsd: bigint} | {ok: false; tx: Hex | null; error: string}> {
  const data = finalizeData(s);
  try {
    await c.call({account: account.address, to: k.settlement, data});
  } catch (error) {
    return {ok: false, tx: null, error: nameRevert(error)};
  }
  let tx: Hex;
  try {
    tx = await sendToSettlement(c, account, k, data);
  } catch (error) {
    return {ok: false, tx: null, error: nameRevert(error)};
  }
  const receipt = await c.waitForTransactionReceipt({hash: tx, pollingInterval: 250, timeout: 30_000});
  if (receipt.status !== "success") return {ok: false, tx, error: await replayRevert(c, receipt, account.address, k.settlement, data)};

  const logs = parseEventLogs({abi: settlementAbi(), logs: receipt.logs, strict: false}) as unknown as {eventName: string; args: Record<string, unknown>}[];
  const settled = logs.find((l) => l.eventName === "BatchSettled");
  const passthrough = logs.find((l) => l.eventName === "BatchPassthrough");
  const failed = logs.filter((l) => l.eventName === "IntentCollectionFailed").map((l) => `${l.args.owner} at intent ${l.args.intentIndex}`);
  const intentsSettled = logs.filter((l) => l.eventName === "IntentSettled").length;
  const result = settled
    ? "BatchSettled"
    : passthrough
      ? `BatchPassthrough "${passthrough.args.reason}"${failed.length ? `, collection failed for ${failed.join(", ")}` : ""}`
      : "no settlement event";
  return {ok: true, tx, block: receipt.blockNumber, result, intentsSettled, savingsUsd: settled ? (settled.args.totalSavingsUsd as bigint) : 0n};
}

export async function finalizeWon(c: PublicClient, account: HDAccount, k: Contracts, s: Solution, store: Store, log: (line: string) => void = () => {}): Promise<FinalizeOutcome> {
  const solveEnd = s.batchId + SOLUTION_WINDOW;
  const deadline = solveEnd + FINALIZE_DEADLINE;
  const done = (outcome: FinalizeOutcome): FinalizeOutcome => {
    store.update(s.batchId, {status: outcome.status, finalizeTx: outcome.tx, reason: outcome.result});
    return outcome;
  };
  const none = {tx: null, block: null, intentsSettled: 0, savingsUsd: 0n};

  const after = await untilBlock(c, (ts) => ts > solveEnd, deadline);
  if (!after) return done({...none, status: "abandoned", result: `no block after solveEnd ${solveEnd} before the deadline ${deadline}`});

  const stored = store.read(s.batchId);
  const [hash, , winner] = (await c.readContract({address: k.settlement, abi: settlementAbi(), functionName: "bestSolution", args: [s.batchId]})) as [Hex, bigint, Address];
  if (winner.toLowerCase() !== account.address.toLowerCase() || (stored.ok && hash !== stored.record.hash)) {
    return done({...none, status: "not_best", result: `bestSolution names ${winner}, hash ${hash}`});
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const head = (await c.getBlock()).timestamp;
    if (head > deadline) return done({...none, status: "abandoned", result: `deadline ${deadline} passed before finalize was sent`});
    const r = await tryFinalize(c, account, k, s);
    if (r.ok) return done({status: "finalized", tx: r.tx, block: r.block, result: r.result, intentsSettled: r.intentsSettled, savingsUsd: r.savingsUsd});
    if (r.error.startsWith("AlreadyFinalized")) return done({...none, tx: r.tx, status: "finalized_by_other", result: r.error});
    log(`  finalize ${s.batchId} attempt ${attempt + 1} reverts ${r.error}`);
    if (attempt === 1) {
      const suspects = s.intents.map((i, n) => `${n}:${i.owner}`).join(" ");
      return done({...none, tx: r.tx, status: "finalize_reverted", result: `${r.error}, intents ${suspects}`});
    }
    const next = await untilBlock(c, (ts) => ts > head, deadline);
    if (!next) return done({...none, status: "abandoned", result: `deadline ${deadline} passed after finalize reverted ${r.error}`});
  }
  throw new Error("unreachable");
}
