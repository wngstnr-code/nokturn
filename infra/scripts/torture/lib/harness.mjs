// The setup every group shares. Fork check, snapshot, a fresh API, and a revert
// that runs whatever happened in between.

import {after, before} from "node:test";
import {startChaosProxy} from "../rpc-chaos-proxy.mjs";
import {get, startApi} from "./api.mjs";
import {openGroup} from "./evidence.mjs";
import {FORK_RPC, chainNow, requireFork, revert, rpc, snapshot, warpTo} from "./fork.mjs";

/**
 * Nonces far above anything GET /v1/nonces suggests, so a scenario that uses
 * the suggested nonce never collides with one that picks its own. Each group
 * gets its own range.
 */
export function nonceSource(groupIndex) {
  let next = 10n ** 12n * BigInt(groupIndex + 1);
  return () => {
    next += 1n;
    return next;
  };
}

/**
 * snap false is for a group that restarts the node itself, where a snapshot
 * taken before the restart no longer exists afterwards.
 */
export function useGroup(testFileUrl, {proxy = false, api = true, snap = true} = {}) {
  const state = {record: openGroup(testFileUrl), api: null, proxy: null, snap: null};

  before(async () => {
    await requireFork();
    if (snap) state.snap = await snapshot();
    if (proxy) state.proxy = await startChaosProxy({upstream: FORK_RPC});
    if (api) state.api = await startApi({rpc: state.proxy?.url ?? FORK_RPC});
  });

  after(async () => {
    await state.api?.stop();
    await state.proxy?.close();
    if (state.snap) await revert(state.snap);
  });

  return state;
}

/** Restarts the group's API, which is the only way to empty the mempool. */
export async function restartApi(state, env) {
  await state.api?.stop();
  state.api = await startApi({rpc: state.proxy?.url ?? FORK_RPC, env});
  return state.api;
}

export async function currentBatch(api) {
  const res = await get(api, "/v1/batches/current");
  if (res.status !== 200) throw new Error(`GET /v1/batches/current answered ${res.status}: ${res.text}`);
  return res.body;
}

/**
 * Makes sure the batch now collecting has at least minSeconds of chain time
 * left, warping to the start of the next one when it does not. Scenarios that
 * compare several responses about one batch need this, or a boundary falls
 * between two requests and the comparison fails for a reason that is not a bug.
 */
export async function freshWindow(api, minSeconds = 20) {
  let batch = await currentBatch(api);
  if (batch.batchId === null || batch.collectEndsAt - batch.chainTime < minSeconds) {
    await warpTo(BigInt(batch.batchId === null ? batch.chainTime + 1 : batch.collectEndsAt) + 1n);
    batch = await currentBatch(api);
  }
  return batch;
}

/** Runs fn over items with at most n in flight, results in input order. */
export async function pool(items, n, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({length: Math.min(n, items.length)}, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Turns the fork's interval miner off for the length of fn, so a scenario
 * about one exact second sees that second and not the one after it. Blocks are
 * then mined only by warpTo and sendAs.
 */
export async function manualMining(fn) {
  await rpc("evm_setIntervalMining", [0]);
  try {
    return await fn();
  } finally {
    await rpc("evm_setIntervalMining", [Number(process.env.NOKTURN_FORK_BLOCK_TIME ?? 1)]);
  }
}

export {chainNow};
