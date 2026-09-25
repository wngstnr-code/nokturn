// The indexer.
//
//   node indexer/src/index.ts --until-block <n>   stops once n is indexed
//   node indexer/src/index.ts --duration <min>    stops after that many chain minutes
//   node indexer/src/index.ts                     runs as a service, for the demo
//   --confirmations <n>                           indexes only to head - n, required above 0 off a fork
//
// Steps are driven by new blocks, never by a timer. A failed step backs off from
// one second, doubling, to at most thirty, and a refused getLogs range stops the
// process instead of retrying something that cannot succeed.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createPublicClient, http, type PublicClient} from "viem";
import {INDEXED, REPO_ROOT, type ContractKey} from "./abi.ts";
import {closeDb, migrate} from "./db.ts";
import {Ingest, RangeRefused, type Deployment} from "./ingest.ts";
import {PgStore, type IndexStore} from "./store.ts";

export const RPC = process.env.NOKTURN_INDEXER_RPC ?? "http://127.0.0.1:8545";
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function client(rpc = RPC): PublicClient {
  return createPublicClient({transport: http(rpc, {timeout: 10_000, retryCount: 0})});
}

/**
 * A JSON-RPC error response is a final answer as far as viem's own transport
 * retryCount is concerned, so a chaos proxy or a flaky node that returns one
 * crashes a one-shot boot read before the indexer processes a single block.
 * I5 found this at 30 percent injected errors. solver/src/chain.ts carries
 * the same fix under the same name, for the same reason.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5, baseDelayMs = 250): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

/**
 * The deployment record and its first block. Deploy.s.sol does not record the
 * block it deployed at, so on a fork the pinned block stands in. Nothing of
 * Nokturn can exist at or below it, because the fork starts empty of Nokturn.
 */
export async function loadDeployment(c: PublicClient): Promise<Deployment> {
  const chainId = await withRetry(() => c.getChainId());
  const forkRecord = process.env.NOKTURN_INDEXER_DEPLOYMENT ?? join(REPO_ROOT, "infra", "fork-deployment.json");
  let record: Record<string, unknown>;
  let fromBlock: bigint;
  try {
    record = JSON.parse(readFileSync(forkRecord, "utf8"));
    fromBlock = BigInt(JSON.parse(readFileSync(join(REPO_ROOT, "infra", "pinned-block.json"), "utf8")).block) + 1n;
  } catch {
    const path = join(REPO_ROOT, "contracts", "deployments", `${chainId}.json`);
    record = JSON.parse(readFileSync(path, "utf8"));
    if (record.deployBlock === undefined) throw new Error(`${path} names no deployBlock, and without one the indexer does not know where to start`);
    fromBlock = BigInt(String(record.deployBlock));
  }
  const contracts = new Map<string, ContractKey>();
  for (const key of Object.keys(INDEXED) as ContractKey[]) {
    const address = record[key];
    if (typeof address === "string") contracts.set(address.toLowerCase(), key);
  }
  if (typeof record.settlement !== "string") throw new Error(`${forkRecord} names no settlement. run make deploy`);
  return {chainId, settlement: record.settlement.toLowerCase(), contracts, fromBlock};
}

/** Same probe as api/src/chain.ts. A fork answers with the forked chain's id, so the id alone cannot tell. */
export async function isFork(c: PublicClient): Promise<boolean> {
  try {
    await c.request({method: "anvil_nodeInfo" as never, params: [] as never});
    return true;
  } catch {
    return false;
  }
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
  const depth = flag("--confirmations");
  run({untilBlock: until === undefined ? undefined : BigInt(until), durationMinutes: duration === undefined ? undefined : Number(duration), confirmations: depth === undefined ? undefined : BigInt(depth)})
    .then(async () => {
      await closeDb();
      process.exitCode = 0;
    })
    .catch(async (error) => {
      console.error(`indexer failed\n  ${(error as Error).message}`);
      await closeDb().catch(() => {});
      process.exitCode = 1;
    });
}
