// What a restart owes the batches the previous process had already committed to.
//
// A record still at built, submitted or best may be a solution Settlement has
// recorded as the winner, and the only way to find out is to ask bestSolution,
// which the finalizer does first. built is included because a crash between the
// send and the store update leaves exactly that. A deadline already passed is
// let go, because nothing sent after it can land.

import type {PublicClient} from "viem";
import type {HDAccount} from "viem/accounts";
import type {Contracts} from "./chain.ts";
import {finalizeWon, type FinalizeOutcome} from "./finalize.ts";
import {FINALIZE_DEADLINE, SOLUTION_WINDOW} from "./send.ts";
import type {Store} from "./store.ts";

const OPEN = new Set(["built", "submitted", "best"]);

export interface Recovered {
  batchId: bigint;
  outcome: Promise<FinalizeOutcome | {status: "abandoned"; result: string}>;
}

export async function recover(c: PublicClient, account: HDAccount, k: Contracts, store: Store, log: (line: string) => void): Promise<Recovered[]> {
  const head = (await c.getBlock()).timestamp;
  const out: Recovered[] = [];
  for (const id of store.batchIds()) {
    const batchId = BigInt(id);
    const read = store.read(id);
    if (!read.ok) {
      log(`recover ${id}: record refused, ${read.reason}`);
      continue;
    }
    if (!OPEN.has(read.record.status)) continue;
    const deadline = batchId + SOLUTION_WINDOW + FINALIZE_DEADLINE;
    if (head > deadline) {
      const result = `found at ${read.record.status} after a restart, deadline ${deadline} already passed at chain time ${head}`;
      store.update(id, {status: "abandoned", reason: result});
      log(`recover ${id}: abandoned, ${result}`);
      out.push({batchId, outcome: Promise.resolve({status: "abandoned", result})});
      continue;
    }
    log(`recover ${id}: ${read.record.status}, handing to the finalizer`);
    out.push({batchId, outcome: finalizeWon(c, account, k, read.solution, store, log)});
  }
  return out;
}
