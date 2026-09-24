// One ingest step, from the checkpoint to at most MAX_RANGE blocks further.
//
// Every bound the plan names lives here. getLogs never spans more than 500
// blocks, a revert is traced back through at most 64 stored blocks, and past
// that the deployment is reindexed from its first block once. A second full
// reset inside ten minutes is an error, not a loop.

import {decodeEventLog, decodeFunctionData, encodeAbiParameters, keccak256, toEventSelector, type Abi, type AbiEvent, type Address, type Hex, type Log, type PublicClient} from "viem";
import {INDEXED, loadAbi, type ContractKey} from "./abi.ts";
import type {DecodedLog, Op} from "./project.ts";
import type {BlockRow, Checkpoint, IndexStore, UndecodedLog} from "./store.ts";

export const MAX_RANGE = 500n;
export const MAX_REWIND = 64;
const FULL_RESET_WINDOW_MS = 10 * 60_000;

/**
 * A transient RPC failure and a block that genuinely does not exist here both
 * throw from getBlock, and only one of them means the chain reorged. I5 found
 * that treating every failure as "not found" turns a flaky node into a false
 * revert, and under sustained chaos, into a false second full reset. This
 * gives a getBlock used for that judgment one extra try before it is believed.
 *
 * Kept to two attempts on purpose. rewind() calls this once per candidate,
 * sequentially, for up to MAX_REWIND candidates, so a generous retry budget
 * here multiplies into minutes under a sustained chaos rate rather than the
 * single stray blip it exists to smooth over.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 2, baseDelayMs = 150, final: (error: unknown) => boolean = () => false): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || final(error)) throw error;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Every read inside step() gets its own retries. A step makes one getBlock per
 * block holding a log, so without them its chance of finishing is 0.7^k under a
 * 30 percent error rate, and N10 measured zero progress in 51 minutes. At four
 * attempts a read fails 0.8 percent of the time, and a step of 30 reads still
 * lands about four times in five.
 */
const READ_ATTEMPTS = 4;
const read = <T>(fn: () => Promise<T>, final?: (error: unknown) => boolean) => withRetry(fn, READ_ATTEMPTS, 100, final);
const RANGE_REFUSAL = /range|too many|limit|exceed/i;

export interface Deployment {
  chainId: number;
  settlement: string;
  /** Lowercase address to the contract key it was deployed as. */
  contracts: Map<string, ContractKey>;
  fromBlock: bigint;
}

interface Decoder {
  abi: Abi;
  name: string;
}

export function decoders(d: Deployment): Map<string, Decoder> {
  const out = new Map<string, Decoder>();
  for (const [address, key] of d.contracts) out.set(address, {abi: loadAbi(INDEXED[key]), name: INDEXED[key]});
  return out;
}

/** JSON safe copy of decoded arguments. uints as strings, hex lowercase, tuples recursed. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.startsWith("0x") ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  return value;
}

export function decodeLog(log: Pick<Log, "address" | "topics" | "data">, decoder: Decoder | undefined): {event: string; contract: string; args: Record<string, unknown>} | {error: string} {
  if (!decoder) return {error: `no indexed contract at ${log.address}`};
  try {
    const decoded = decodeEventLog({abi: decoder.abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true});
    return {event: decoded.eventName!, contract: decoder.name, args: jsonSafe(decoded.args ?? {}) as Record<string, unknown>};
  } catch (error) {
    return {error: (error as Error).message.split("\n")[0]!};
  }
}

/** Every topic0 a deployment emits, so a mismatch in the ABI is visible at boot. */
export function eventSelectors(d: Deployment): Set<string> {
  const out = new Set<string>();
  for (const {abi} of decoders(d).values()) for (const item of abi) if (item.type === "event") out.add(toEventSelector(item as AbiEvent));
  return out;
}

export class RangeRefused extends Error {}

export interface StepResult {
  from: bigint;
  to: bigint;
  logs: number;
  undecoded: number;
  rewoundTo: bigint | null;
  fullReset: boolean;
}

export class Ingest {
  private lastFullReset = 0;
  private readonly decode: Map<string, Decoder>;
  readonly c: PublicClient;
  readonly store: IndexStore;
  readonly d: Deployment;
  readonly log: (line: string) => void;

  constructor(c: PublicClient, store: IndexStore, d: Deployment, log: (line: string) => void = () => {}) {
    this.c = c;
    this.store = store;
    this.d = d;
    this.log = log;
    this.decode = decoders(d);
  }

  private async initial(): Promise<Checkpoint> {
    const start = this.d.fromBlock - 1n;
    const block = await this.c.getBlock({blockNumber: start});
    return {chainId: this.d.chainId, settlement: this.d.settlement, fromBlock: this.d.fromBlock, lastBlock: start, lastHash: block.hash!};
  }

  async checkpoint(): Promise<Checkpoint> {
    return (await this.store.checkpoint(this.d.chainId, this.d.settlement)) ?? (await this.initial());
  }

  /**
   * Finds the newest stored block the chain still agrees with and rolls back to
   * it. Returns the height it rolled back to, or null when it had to start over.
   */
  private async rewind(cp: Checkpoint): Promise<{to: bigint; full: boolean}> {
    const stored = await this.store.storedBlocks(this.d.chainId, this.d.settlement, cp.lastBlock, MAX_REWIND);
    for (const s of stored) {
      const onChain = await withRetry(() => this.c.getBlock({blockNumber: s.number})).catch(() => null);
      if (onChain?.hash === s.hash) {
        await this.store.rewind({...cp, lastBlock: s.number, lastHash: s.hash});
        this.log(`revert detected at ${cp.lastBlock}, rolled back to ${s.number}`);
        return {to: s.number, full: false};
      }
    }
    const now = Date.now();
    if (now - this.lastFullReset < FULL_RESET_WINDOW_MS) {
      throw new Error(`second full reset inside ten minutes. no block among the last ${MAX_REWIND} stored matches the chain twice running, which is a node that keeps rewriting history, not a revert. stopping rather than looping`);
    }
    this.lastFullReset = now;
    const fresh = await this.initial();
    await this.store.rewind(fresh);
    this.log(`no common ancestor within ${MAX_REWIND} stored blocks, reindexing from ${this.d.fromBlock}`);
    return {to: fresh.lastBlock, full: true};
  }

  async step(): Promise<StepResult> {
    let cp = await this.checkpoint();
    let rewoundTo: bigint | null = null;
    let fullReset = false;

    const at = await withRetry(() => this.c.getBlock({blockNumber: cp.lastBlock})).catch(() => null);
    if (at?.hash !== cp.lastHash) {
      const r = await this.rewind(cp);
      rewoundTo = r.to;
      fullReset = r.full;
      cp = await this.checkpoint();
    }

    const head = await read(() => this.c.getBlockNumber());
    const from = cp.lastBlock + 1n;
    const to = head < cp.lastBlock + MAX_RANGE ? head : cp.lastBlock + MAX_RANGE;
    if (to < from) return {from, to: cp.lastBlock, logs: 0, undecoded: 0, rewoundTo, fullReset};

    let raw: Log[];
    try {
      raw = await read(
        () => this.c.getLogs({address: [...this.d.contracts.keys()] as Address[], fromBlock: from, toBlock: to}),
        (error) => RANGE_REFUSAL.test((error as Error).message),
      );
    } catch (error) {
      const message = (error as Error).message;
      if (RANGE_REFUSAL.test(message)) {
        throw new RangeRefused(`the node refused getLogs over ${from} to ${to}. this indexer asks for up to ${MAX_RANGE} blocks per call and does not fall back to one block at a time. point it at a node that serves ranges, the local anvil fork does. ${message.split("\n")[0]}`);
      }
      throw error;
    }

    const heights = new Set<bigint>([to, ...raw.map((l) => l.blockNumber!)]);
    const blocks = new Map<bigint, BlockRow>();
    for (const n of heights) {
      const b = await read(() => this.c.getBlock({blockNumber: n}));
      blocks.set(n, {number: n, hash: b.hash!, parentHash: b.parentHash, timestamp: b.timestamp});
    }
    // A log whose block hash is not the block we just read belongs to a history
    // that changed between the two calls. Nothing is written, and the next step
    // finds the revert through the checkpoint.
    const moved = raw.find((l) => blocks.get(l.blockNumber!)!.hash !== l.blockHash);
    if (moved) throw new Error(`block ${moved.blockNumber} changed between getLogs and getBlock, retrying from the checkpoint`);

    const logs: DecodedLog[] = [];
    const undecoded: UndecodedLog[] = [];
    for (const l of raw) {
      const address = l.address.toLowerCase();
      const r = decodeLog(l, this.decode.get(address));
      if ("error" in r) {
        undecoded.push({blockNumber: l.blockNumber!, txHash: l.transactionHash!.toLowerCase(), logIndex: l.logIndex!, address, topics: l.topics.map((t) => t.toLowerCase()), data: l.data, error: r.error});
        this.log(`undecoded log ${l.transactionHash}:${l.logIndex} at ${address}, ${r.error}`);
        continue;
      }
      logs.push({
        chainId: this.d.chainId,
        deployment: this.d.settlement,
        blockNumber: l.blockNumber!,
        blockHash: l.blockHash!.toLowerCase(),
        blockTimestamp: blocks.get(l.blockNumber!)!.timestamp,
        txHash: l.transactionHash!.toLowerCase(),
        logIndex: l.logIndex!,
        address,
        contract: r.contract,
        event: r.event,
        args: r.args,
      });
    }

    const extra = await this.winningSolutions(logs);
    const last = blocks.get(to)!;
    await this.store.commit({checkpoint: {...cp, lastBlock: to, lastHash: last.hash}, blocks: [...blocks.values()], logs, undecoded, extra});
    return {from, to, logs: logs.length, undecoded: undecoded.length, rewoundTo, fullReset};
  }

  /**
   * The winning Solution from the calldata of each finalize in this range. It is
   * the only onchain source for minOut, receiver, sellAmount and the intent
   * flags. expireBatch closes a batch too, and has no Solution to decode.
   */
  private async winningSolutions(logs: DecodedLog[]): Promise<Op[]> {
    const settlementAbi = loadAbi("Settlement");
    const finalize = settlementAbi.find((x) => x.type === "function" && x.name === "finalize");
    const closing = logs.filter((l) => l.contract === "Settlement" && (l.event === "BatchSettled" || l.event === "BatchPassthrough"));
    const seen = new Set<string>();
    const ops: Op[] = [];
    for (const l of closing) {
      if (seen.has(l.txHash)) continue;
      seen.add(l.txHash);
      const tx = await read(() => this.c.getTransaction({hash: l.txHash as Hex}));
      let decoded;
      try {
        decoded = decodeFunctionData({abi: settlementAbi, data: tx.input});
      } catch {
        continue;
      }
      if (decoded.functionName !== "finalize" || !finalize || finalize.type !== "function") continue;
      const [batchId, solution] = decoded.args as [bigint, unknown];
      const hash = keccak256(encodeAbiParameters([finalize.inputs[1]!], [solution as never]));
      ops.push({
        kind: "insert",
        table: "batch_solutions",
        row: {deployment: l.deployment, batch_id: String(batchId), solution_hash: hash, solution: JSON.stringify(jsonSafe(solution)), chain_id: l.chainId, block_number: String(l.blockNumber), block_timestamp: String(l.blockTimestamp), tx_hash: l.txHash, log_index: l.logIndex},
      });
    }
    return ops;
  }
}
