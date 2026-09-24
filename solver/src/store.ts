// Every solution this solver submits, kept byte for byte until finalize.
//
// finalize demands keccak256(abi.encode(s)) identical to the one submitSolution
// stored. A solver that crashes between the two and cannot rebuild the exact
// bytes is slashed by expireBatch, so the record is written before the submit
// transaction leaves, and read back only if its hash still matches.

import {mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {decodeAbiParameters, encodeAbiParameters, keccak256, type Address, type Hex} from "viem";
import {REPO_ROOT} from "./abi.ts";
import {solutionAbiParameters, type Solution} from "./solution.ts";

export type Status =
  | "built"
  | "submitted"
  | "best"
  | "not_best"
  | "finalized"
  | "finalized_passthrough"
  | "finalized_by_other"
  | "finalize_reverted"
  | "abandoned";

export interface Record {
  batchId: string;
  status: Status;
  /** abi.encode(s), the exact bytes finalize is called with. */
  solution: Hex;
  hash: Hex;
  submitTx: Hex | null;
  finalizeTx: Hex | null;
  /** Why the batch ended where it did, for every status that is not plain success. */
  reason: string | null;
  updatedAt: string;
}

export function storeDir(chainId: number, settlement: Address): string {
  return process.env.NOKTURN_SOLVER_STATE ?? join(REPO_ROOT, "solver", ".state", `${chainId}-${settlement.toLowerCase()}`);
}

export function encodeStored(s: Solution): Hex {
  return encodeAbiParameters(solutionAbiParameters(), [s]);
}

export function decodeStored(hex: Hex): Solution {
  return decodeAbiParameters(solutionAbiParameters(), hex)[0] as Solution;
}

export class Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, {recursive: true});
  }

  private path(batchId: bigint | string): string {
    return join(this.dir, `${batchId}.json`);
  }

  /** Temp file and rename, so a crash mid write leaves the old record or none, never half of one. */
  write(record: Omit<Record, "updatedAt">): Record {
    const full: Record = {...record, updatedAt: new Date().toISOString()};
    const target = this.path(record.batchId);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(full, null, 2));
    renameSync(tmp, target);
    return full;
  }

  built(s: Solution): Record {
    const solution = encodeStored(s);
    return this.write({batchId: String(s.batchId), status: "built", solution, hash: keccak256(solution), submitTx: null, finalizeTx: null, reason: null});
  }

  update(batchId: bigint | string, patch: Partial<Pick<Record, "status" | "submitTx" | "finalizeTx" | "reason">>): Record {
    const current = this.read(batchId);
    if (!current.ok) throw new Error(`cannot update batch ${batchId}: ${current.reason}`);
    return this.write({...current.record, ...patch});
  }

  /** The hash is recomputed from the bytes. A record that disagrees with itself is not trusted. */
  read(batchId: bigint | string): {ok: true; record: Record; solution: Solution} | {ok: false; reason: string} {
    let record: Record;
    try {
      record = JSON.parse(readFileSync(this.path(batchId), "utf8")) as Record;
    } catch (error) {
      return {ok: false, reason: `unreadable record, ${(error as Error).message.split("\n")[0]}`};
    }
    if (typeof record.solution !== "string" || !record.solution.startsWith("0x")) return {ok: false, reason: "record carries no solution bytes"};
    const hash = keccak256(record.solution);
    if (hash !== record.hash) return {ok: false, reason: `stored hash ${record.hash} does not match the stored bytes, which hash to ${hash}`};
    let solution: Solution;
    try {
      solution = decodeStored(record.solution);
    } catch (error) {
      return {ok: false, reason: `stored bytes do not decode as a Solution, ${(error as Error).message.split("\n")[0]}`};
    }
    if (String(solution.batchId) !== String(batchId)) return {ok: false, reason: `record for ${batchId} holds a solution for batch ${solution.batchId}`};
    return {ok: true, record, solution};
  }

  batchIds(): string[] {
    return readdirSync(this.dir)
      .filter((f) => /^[0-9]+\.json$/.test(f))
      .map((f) => f.slice(0, -5));
  }
}
