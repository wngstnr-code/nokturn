// F21, the submit half. One solution per batch, sent only while the window is
// open by chain time, and only after the dry run says it would land.

import {createWalletClient, http, parseEventLogs, stringToHex, type Hex, type PublicClient, type TransactionReceipt} from "viem";
import type {HDAccount} from "viem/accounts";
import {settlementAbi} from "./abi.ts";
import {RPC, type Contracts} from "./chain.ts";
import {encodeSolution, type Solution} from "./solution.ts";
import {nameRevert, simulateSubmit} from "./simulate.ts";
import type {Store} from "./store.ts";

export type SendOutcome =
  | {status: "window_missed"; reason: string}
  | {status: "simulation_reverted"; reason: string}
  | {status: "best" | "not_best"; tx: Hex; block: bigint}
  | {status: "submit_reverted"; tx: Hex | null; reason: string};

const NOT_THE_BEST = stringToHex("not the best", {size: 32});

/** Settlement.SOLUTION_WINDOW and FINALIZE_DEADLINE, parameter.md section 6. */
export const SOLUTION_WINDOW = 10n;
export const FINALIZE_DEADLINE = 300n;

/** Gives the receipt this long past solveEnd, in chain seconds, before calling it lost. */
const RECEIPT_GRACE_SECONDS = 5n;

export function wallet(account: HDAccount, rpc = RPC) {
  return createWalletClient({account, transport: http(rpc, {timeout: 8_000, retryCount: 0})});
}

function isNonceTooLow(error: unknown): boolean {
  return /nonce too low|nonce has already been used/i.test(String((error as Error)?.message ?? error));
}

/** Sends data to Settlement with a pending nonce, refetching it once on "nonce too low". */
export async function sendToSettlement(c: PublicClient, account: HDAccount, k: Contracts, data: Hex): Promise<Hex> {
  const w = wallet(account);
  const gas = await c.estimateGas({account: account.address, to: k.settlement, data});
  // A fifth over the estimate, because the estimate is taken one block before
  // the transaction lands and a pool read can cost more by then.
  const limit = (gas * 6n) / 5n;
  for (let attempt = 0; ; attempt += 1) {
    const nonce = await c.getTransactionCount({address: account.address, blockTag: "pending"});
    try {
      return await w.sendTransaction({account, chain: null, to: k.settlement, data, gas: limit, nonce});
    } catch (error) {
      if (attempt === 0 && isNonceTooLow(error)) continue;
      throw error;
    }
  }
}

/** Replays a mined transaction as a call on its own block to name why it reverted. */
export async function replayRevert(c: PublicClient, receipt: TransactionReceipt, from: Hex, to: Hex, data: Hex): Promise<string> {
  try {
    await c.call({account: from, to, data, blockNumber: receipt.blockNumber});
    return "reverted on chain, and the replay on the same block passes";
  } catch (error) {
    return nameRevert(error);
  }
}

export async function submit(c: PublicClient, account: HDAccount, k: Contracts, s: Solution, store: Store): Promise<SendOutcome> {
  const solveEnd = s.batchId + SOLUTION_WINDOW;
  const now = (await c.getBlock()).timestamp;
  if (now > solveEnd) return {status: "window_missed", reason: `chain time ${now} is past solveEnd ${solveEnd}`};

  const sim = await simulateSubmit(c, k, s, account.address);
  if (!sim.ok) return {status: "simulation_reverted", reason: sim.error};

  store.built(s);
  const data = encodeSolution(s);
  let tx: Hex;
  try {
    tx = await sendToSettlement(c, account, k, data);
  } catch (error) {
    const reason = nameRevert(error);
    store.update(s.batchId, {status: "abandoned", reason: `submit not sent, ${reason}`});
    return {status: "submit_reverted", tx: null, reason};
  }
  store.update(s.batchId, {status: "submitted", submitTx: tx});

  const left = solveEnd - (await c.getBlock()).timestamp + RECEIPT_GRACE_SECONDS;
  let receipt: TransactionReceipt;
  try {
    receipt = await c.waitForTransactionReceipt({hash: tx, timeout: Number(left > 1n ? left : 1n) * 1_000, pollingInterval: 250});
  } catch (error) {
    // Left as submitted. The finalizer asks bestSolution, which is the only
    // answer to whether this transaction landed that cannot be wrong.
    return {status: "submit_reverted", tx, reason: `no receipt inside the window, ${(error as Error).message.split("\n")[0]}`};
  }

  if (receipt.status !== "success") {
    const reason = await replayRevert(c, receipt, account.address, k.settlement, data);
    store.update(s.batchId, {status: "abandoned", reason: `submit reverted, ${reason}`});
    return {status: "submit_reverted", tx, reason};
  }

  const logs = parseEventLogs({abi: settlementAbi(), logs: receipt.logs, strict: false});
  const rejected = logs.find((l) => l.eventName === "SolutionRejected") as {args: {reason?: Hex}} | undefined;
  const status = rejected && rejected.args.reason === NOT_THE_BEST ? "not_best" : "best";
  store.update(s.batchId, {status, reason: rejected ? `rejected on chain, ${rejected.args.reason}` : null});
  return {status, tx, block: receipt.blockNumber};
}
