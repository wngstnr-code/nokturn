// The indexer.
//
//   node indexer/src/index.ts --until-block <n>   stops once n is indexed
//   node indexer/src/index.ts --duration <min>    stops after that many chain minutes
//   node indexer/src/index.ts                     runs as a service, for the demo
//   --confirmations <n>                           indexes only to head - n, required above 0 off a fork
//   node indexer/src/index.ts --reconcile [--at-block <n>]   rows against the chain, exit 1 on any difference
//
// Steps are driven by new blocks, never by a timer. A failed step backs off from
// one second, doubling, to at most thirty, and a refused getLogs range stops the
// process instead of retrying something that cannot succeed. A rate limit is not
// a refusal, it backs off like any other failed step.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createPublicClient, http, type Address, type PublicClient} from "viem";
import {unknownMethod} from "../../packages/shared/rpc.ts";
import {INDEXED, REPO_ROOT, loadAbi, type ContractKey} from "./abi.ts";
import {recordBaselines} from "./baseline.ts";
import {closeDb, db, migrate} from "./db.ts";
import {Ingest, RangeRefused, type Deployment} from "./ingest.ts";
import {reconcile, report, viemReader} from "./reconcile.ts";
import {PgStore, type IndexStore} from "./store.ts";

export const RPC = process.env.NOKTURN_INDEXER_RPC ?? "http://127.0.0.1:8545";
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function client(rpc = RPC): PublicClient {
  // No block number cache. Its four seconds outlive an evm_revert on the fork,
  // and a head that old points at blocks that no longer exist.
  return createPublicClient({cacheTime: 0, transport: http(rpc, {timeout: 10_000, retryCount: 0})});
}

/**
 * A JSON-RPC error response is a final answer as far as viem's own transport
 * retryCount is concerned, so a chaos proxy or a flaky node that returns one
 * crashes a one-shot boot read before the indexer processes a single block.
 * I5 found this at 30 percent injected errors. solver/src/chain.ts carries
 * the same fix under the same name, for the same reason.
 *
 * About ten minutes in all before it gives up, each wait capped at the step
 * loop's thirty seconds. Every boot that gave up counted toward the restarts
 * Railway allows before it marks the service crashed. A minute covered the
 * rate limit of 2 October 2026 but not the Cloudflare 403 challenges of
 * 4 and 5 October, which lasted minutes and used up every restart.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 25, baseDelayMs = 500): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const wait = Math.min(baseDelayMs * 2 ** (attempt - 1), BACKOFF_MAX_MS);
      console.log(`boot read failed, attempt ${attempt} of ${attempts}, retrying in ${wait / 1_000}s. ${(error as Error).message.split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/**
 * The deployment record and its first block. Which record is decided by asking
 * the node, not by which file happens to exist, because a laptop that ran the
 * fork keeps infra/fork-deployment.json and would otherwise index a fork
 * Settlement address on mainnet and find nothing, silently.
 *
 * Deploy.s.sol does not record the block it deployed at. On a fork the pinned
 * block stands in, since the fork starts empty of Nokturn. Elsewhere the first
 * block where Settlement has code is found on chain.
 */
export async function loadDeployment(c: PublicClient): Promise<Deployment> {
  const chainId = await withRetry(() => c.getChainId());
  const fork = await isFork(c);
  const path =
    process.env.NOKTURN_INDEXER_DEPLOYMENT ??
    (fork ? join(REPO_ROOT, "infra", "fork-deployment.json") : join(REPO_ROOT, "contracts", "deployments", `${chainId}.json`));
  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (typeof record.settlement !== "string") throw new Error(`${path} names no settlement. run make deploy`);
  const settlement = record.settlement.toLowerCase();

  let fromBlock: bigint;
  if (fork) {
    // Asked of the node, because make keeper-fork forks 1.3 million blocks
    // before the block in infra/pinned-block.json, and starting there would
    // index nothing on it without saying so.
    fromBlock = (await forkBlock(c)) + 1n;
  } else if (process.env.NOKTURN_INDEXER_FROM_BLOCK) {
    // For a node without history, where the search below cannot run. The
    // official mainnet RPC keeps about ten minutes of state. The mainnet start
    // was found by that search against an archive endpoint, block 75694415.
    fromBlock = BigInt(process.env.NOKTURN_INDEXER_FROM_BLOCK);
  } else if (record.deployBlock !== undefined) {
    fromBlock = BigInt(String(record.deployBlock));
  } else {
    fromBlock = await firstBlockWithCode(c, settlement as Address);
  }

  const contracts = new Map<string, ContractKey>();
  for (const key of Object.keys(INDEXED) as ContractKey[]) {
    const address = record[key];
    if (typeof address === "string") contracts.set(address.toLowerCase(), key);
  }
  return {chainId, settlement, contracts, fromBlock};
}

/**
 * Binary search on eth_getCode, about thirty reads. Needs an archive endpoint,
 * and a node that only serves latest fails here loudly rather than starting
 * the indexer at the head and skipping every earlier event.
 */
export async function firstBlockWithCode(c: PublicClient, address: Address): Promise<bigint> {
  const hasCode = async (blockNumber: bigint) => {
    const code = await withRetry(() => c.getCode({address, blockNumber}));
    return code !== undefined && code !== "0x";
  };
  let hi = await withRetry(() => c.getBlockNumber());
  if (!(await hasCode(hi))) throw new Error(`${address} has no code at head ${hi}, so this is not the chain it was deployed to`);
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await hasCode(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/**
 * Same probe as api/src/chain.ts. A fork answers with the forked chain's id, so
 * the id alone cannot tell. Only a node that says it does not know the method
 * is taken as not a fork. Any other failure is retried and then thrown, because
 * one dropped request at boot used to read as "not a fork" and the indexer then
 * refused its own zero confirmations. I5 found it.
 */
export async function isFork(c: PublicClient): Promise<boolean> {
  return withRetry(async () => {
    try {
      await c.request({method: "anvil_nodeInfo" as never, params: [] as never});
      return true;
    } catch (error) {
      if (unknownMethod(error)) return false;
      throw error;
    }
  });
}

async function forkBlock(c: PublicClient): Promise<bigint> {
  const info = await withRetry(() => c.request({method: "anvil_nodeInfo" as never, params: [] as never})) as {forkConfig?: {forkBlockNumber?: number}};
  const block = info.forkConfig?.forkBlockNumber;
  if (block) return BigInt(block);
  return BigInt(JSON.parse(readFileSync(join(REPO_ROOT, "infra", "pinned-block.json"), "utf8")).block);
}

export class UnsafeConfirmations extends Error {}

/**
 * Zero is only safe where nothing reorgs behind our back, which is a fork we
 * mine ourselves. Anywhere else a zero is refused rather than quietly raised,
 * because the operator who typed it would then be running a depth they never saw.
 */
export async function confirmationsFor(c: PublicClient, requested: bigint | undefined): Promise<bigint> {
  const fork = await isFork(c);
  if (requested === undefined) {
    if (fork) return 0n;
    throw new UnsafeConfirmations("this node is not an anvil fork, so the indexer needs --confirmations <n> with n above zero. a block indexed at the head of a live chain can still be reorged away");
  }
  if (requested < 0n) throw new UnsafeConfirmations(`--confirmations ${requested} is negative`);
  if (requested === 0n && !fork) throw new UnsafeConfirmations("--confirmations 0 against a node that is not an anvil fork. a block at the head of a live chain can still be reorged away, so pass a depth above zero");
  return requested;
}

export interface RunOptions {
  untilBlock?: bigint;
  durationMinutes?: number;
  confirmations?: bigint;
  store?: IndexStore;
  log?: (line: string) => void;
}

export async function run(opts: RunOptions = {}): Promise<{lastBlock: bigint; steps: number; logs: number}> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const c = client();
  const confirmations = await confirmationsFor(c, opts.confirmations);
  const d = await loadDeployment(c);
  if (!opts.store) {
    const ran = await migrate();
    if (ran.length) log(`applied migrations ${ran.join(", ")}`);
  }
  const ingest = new Ingest(c, opts.store ?? new PgStore(), d, log, confirmations);
  const endAt = opts.durationMinutes === undefined ? null : (await c.getBlock()).timestamp + BigInt(Math.round(opts.durationMinutes * 60));
  log(`indexing ${d.settlement} on chain ${d.chainId} from block ${d.fromBlock}, ${d.contracts.size} contracts, ${confirmations} confirmations${opts.untilBlock !== undefined ? `, until block ${opts.untilBlock}` : ""}${endAt !== null ? `, until chain time ${endAt}` : ""}`);

  let steps = 0;
  let logs = 0;
  let backoff = BACKOFF_START_MS;
  let lastBlock = (await ingest.checkpoint()).lastBlock;

  const done = async () => {
    if (opts.untilBlock !== undefined && lastBlock >= opts.untilBlock) return true;
    if (endAt !== null && (await c.getBlock()).timestamp >= endAt) return true;
    return false;
  };

  // Catch up, then wake on each new block.
  for (;;) {
    try {
      const r = await ingest.step();
      steps += 1;
      logs += r.logs;
      lastBlock = r.to;
      backoff = BACKOFF_START_MS;
      if (r.logs || r.undecoded || r.rewoundTo !== null) log(`blocks ${r.from} to ${r.to}, ${r.logs} logs${r.undecoded ? `, ${r.undecoded} undecoded` : ""}${r.rewoundTo !== null ? `, rewound to ${r.rewoundTo}` : ""}`);
      // After the commit, so the batch rows are there to read. Its own failure
      // never fails the step, because the receipt can still ask the chain.
      if (!opts.store && r.logs) {
        await recordBaselines(db(), c, d.chainId, d.settlement, r.from, r.to, log).catch((error) => log(`baselines for ${r.from} to ${r.to} not stored. ${(error as Error).message.split("\n")[0]}`));
      }
      if (await done()) break;
      // Compared with the confirmed head, not the raw one. Against the raw head a
      // nonzero depth would never look caught up, and this would spin.
      if (r.to >= (await ingest.safeHead())) await nextBlock(c, lastBlock + confirmations);
    } catch (error) {
      if (error instanceof RangeRefused) throw error;
      if ((error as Error).message.startsWith("second full reset")) throw error;
      log(`step failed, retrying in ${backoff / 1_000}s. ${(error as Error).message.split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }
  log(`indexed to block ${lastBlock}, ${steps} steps, ${logs} logs`);
  return {lastBlock, steps, logs};
}

/**
 * Prints the reconciliation and answers 1 when any check differs. The block is
 * the checkpoint unless one is named, and a block above the checkpoint is
 * refused, because rows the indexer has not reached would read as missing.
 */
export async function reconcileCommand(atBlock?: bigint, log: (line: string) => void = (l) => console.log(l)): Promise<number> {
  const c = client();
  const d = await loadDeployment(c);
  const cp = await new PgStore().checkpoint(d.chainId, d.settlement);
  if (!cp) throw new Error(`nothing indexed yet for ${d.settlement}. run the indexer first`);
  const at = atBlock ?? cp.lastBlock;
  if (at > cp.lastBlock) throw new Error(`block ${at} is above the checkpoint ${cp.lastBlock}. reconcile at or below what is indexed`);
  const adapter = (await c.readContract({address: d.settlement as Address, abi: loadAbi("Settlement"), functionName: "baselineAdapter", blockNumber: at})) as Address;
  // The anvil solver accounts mean nothing off the fork.
  const accounts = (await isFork(c))
    ? (JSON.parse(readFileSync(join(REPO_ROOT, "infra", "accounts.json"), "utf8")) as {solverA?: string; solverB?: string})
    : {};
  const checks = await reconcile(db(), viemReader(c, d, at, adapter), d.settlement, at, {solvers: [accounts.solverA, accounts.solverB].filter((s): s is string => Boolean(s))});
  log(`reconciling ${d.settlement} on chain ${d.chainId} at block ${at}`);
  log(report(checks));
  return checks.some((ch) => ch.status === "differ") ? 1 : 0;
}

/** Resolves on the first block above `after`. */
function nextBlock(c: PublicClient, after: bigint): Promise<void> {
  return new Promise((resolve) => {
    const unwatch = c.watchBlockNumber({
      emitOnBegin: true,
      pollingInterval: 500,
      onBlockNumber: (n) => {
        if (n > after) {
          unwatch();
          resolve();
        }
      },
      // A failed poll resolves too, so the step that follows meets the error and
      // backs off, rather than this watcher waiting forever on a dead node.
      onError: () => {
        unwatch();
        resolve();
      },
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const until = flag("--until-block");
  const duration = flag("--duration");
  // The flag, or the environment where a host sets variables but not a command line.
  const depth = flag("--confirmations") ?? process.env.NOKTURN_INDEXER_CONFIRMATIONS;
  const at = flag("--at-block");
  const job: Promise<number> = argv.includes("--reconcile")
    ? reconcileCommand(at === undefined ? undefined : BigInt(at))
    : run({untilBlock: until === undefined ? undefined : BigInt(until), durationMinutes: duration === undefined ? undefined : Number(duration), confirmations: depth === undefined ? undefined : BigInt(depth)}).then(() => 0);
  job
    .then(async (code) => {
      await closeDb();
      process.exitCode = code;
    })
    .catch(async (error) => {
      console.error(`indexer failed\n  ${(error as Error).message}`);
      await closeDb().catch(() => {});
      process.exitCode = 1;
    });
}
