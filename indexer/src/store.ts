// Where the indexer writes. Postgres in production, and an in memory copy with
// the same key semantics for the unit tests, so idempotence and rollback are
// tested without a database.
//
// One step is one commit. The checkpoint moves inside the same transaction as the
// rows it covers, so a process killed halfway leaves neither a gap nor a double.

import type pg from "pg";
import {db, inTransaction} from "./db.ts";
import {DOMAIN_TABLES, KEYS, project, type DecodedLog, type Op, type Row} from "./project.ts";

export interface Checkpoint {
  chainId: number;
  settlement: string;
  fromBlock: bigint;
  lastBlock: bigint;
  lastHash: string;
}

export interface BlockRow {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: bigint;
}

export interface UndecodedLog {
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
  error: string;
}

export interface StepWrite {
  checkpoint: Checkpoint;
  blocks: BlockRow[];
  logs: DecodedLog[];
  undecoded: UndecodedLog[];
  /** Rows that do not come from a log, batch_solutions from finalize calldata. */
  extra: Op[];
}

export interface IndexStore {
  checkpoint(chainId: number, settlement: string): Promise<Checkpoint | null>;
  commit(w: StepWrite): Promise<void>;
  /** Stored block hashes at or below a height, newest first. */
  storedBlocks(chainId: number, settlement: string, atOrBelow: bigint, limit: number): Promise<{number: bigint; hash: string}[]>;
  /** Drops everything above toBlock and rebuilds the domain tables from the logs that remain. */
  rewind(checkpoint: Checkpoint): Promise<void>;
  count(table: string, deployment: string): Promise<number>;
}

function logRow(l: DecodedLog): Row {
  return {
    chain_id: l.chainId,
    deployment: l.deployment,
    block_number: String(l.blockNumber),
    block_hash: l.blockHash,
    block_timestamp: String(l.blockTimestamp),
    tx_hash: l.txHash,
    log_index: l.logIndex,
    address: l.address,
    contract: l.contract,
    event: l.event,
    args: JSON.stringify(l.args),
  };
}

function fromLogRow(r: Row): DecodedLog {
  const args = typeof r.args === "string" ? JSON.parse(r.args) : (r.args as unknown as Record<string, unknown>);
  return {
    chainId: Number(r.chain_id),
    deployment: String(r.deployment),
    blockNumber: BigInt(String(r.block_number)),
    blockHash: String(r.block_hash),
    blockTimestamp: BigInt(String(r.block_timestamp)),
    txHash: String(r.tx_hash),
    logIndex: Number(r.log_index),
    address: String(r.address),
    contract: String(r.contract),
    event: String(r.event),
    args,
  };
}

// ---------------------------------------------------------------------------

export class MemoryStore implements IndexStore {
  readonly tables = new Map<string, Row[]>();
  private state = new Map<string, Checkpoint>();
  private blocks = new Map<string, Map<bigint, string>>();

  rows(table: string): Row[] {
    let t = this.tables.get(table);
    if (!t) this.tables.set(table, (t = []));
    return t;
  }

  private match(row: Row, key: Row): boolean {
    return Object.entries(key).every(([k, v]) => row[k] === v);
  }

  apply(op: Op): void {
    const t = this.rows(op.table);
    if (op.kind === "merge") {
      for (const r of t) if (this.match(r, op.key)) Object.assign(r, op.set);
      return;
    }
    const key = Object.fromEntries((KEYS[op.table] ?? []).map((k) => [k, op.row[k] ?? null]));
    const hit = t.find((r) => this.match(r, key));
    if (!hit) t.push({...op.row});
    else if (op.kind === "upsert") Object.assign(hit, op.row);
  }

  async checkpoint(chainId: number, settlement: string): Promise<Checkpoint | null> {
    const c = this.state.get(`${chainId}:${settlement}`);
    return c ? {...c} : null;
  }

  async commit(w: StepWrite): Promise<void> {
    const {chainId, settlement} = w.checkpoint;
    const logs = this.rows("logs");
    for (const l of w.logs) {
      if (logs.some((r) => r.chain_id === l.chainId && r.tx_hash === l.txHash && r.log_index === l.logIndex)) continue;
      logs.push(logRow(l));
      for (const op of project(l)) this.apply(op);
    }
    const undecoded = this.rows("undecoded_logs");
    for (const u of w.undecoded) {
      if (!undecoded.some((r) => r.tx_hash === u.txHash && r.log_index === u.logIndex)) undecoded.push({chain_id: chainId, deployment: settlement, block_number: String(u.blockNumber), tx_hash: u.txHash, log_index: u.logIndex, address: u.address, topics: JSON.stringify(u.topics), data: u.data, error: u.error});
    }
    for (const op of w.extra) this.apply(op);
    const blocks = this.blocks.get(`${chainId}:${settlement}`) ?? new Map<bigint, string>();
    for (const b of w.blocks) blocks.set(b.number, b.hash);
    this.blocks.set(`${chainId}:${settlement}`, blocks);
    this.state.set(`${chainId}:${settlement}`, {...w.checkpoint});
  }

  async storedBlocks(chainId: number, settlement: string, atOrBelow: bigint, limit: number) {
    const blocks = this.blocks.get(`${chainId}:${settlement}`) ?? new Map<bigint, string>();
    return [...blocks.entries()]
      .filter(([n]) => n <= atOrBelow)
      .sort(([a], [b]) => (a > b ? -1 : 1))
      .slice(0, limit)
      .map(([number, hash]) => ({number, hash}));
  }

  async rewind(c: Checkpoint): Promise<void> {
    const above = (r: Row) => r.deployment === c.settlement && BigInt(String(r.block_number)) > c.lastBlock;
    for (const table of ["logs", "undecoded_logs", "batch_solutions"]) this.tables.set(table, this.rows(table).filter((r) => !above(r)));
    for (const table of DOMAIN_TABLES) this.tables.set(table, this.rows(table).filter((r) => r.deployment !== c.settlement));
    const remaining = this.rows("logs")
      .filter((r) => r.deployment === c.settlement)
      .map(fromLogRow)
      .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    for (const l of remaining) for (const op of project(l)) this.apply(op);
    const blocks = this.blocks.get(`${c.chainId}:${c.settlement}`);
    if (blocks) for (const n of [...blocks.keys()]) if (n > c.lastBlock) blocks.delete(n);
    this.state.set(`${c.chainId}:${c.settlement}`, {...c});
  }

  async count(table: string, deployment: string): Promise<number> {
    return this.rows(table).filter((r) => r.deployment === deployment).length;
  }
}

// ---------------------------------------------------------------------------

const ident = (name: string) => {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`refusing identifier ${name}`);
  return name;
};

async function applyPg(client: pg.PoolClient, op: Op): Promise<void> {
  if (op.kind === "merge") {
    const setCols = Object.keys(op.set);
    const keyCols = Object.keys(op.key);
    const sql = `UPDATE ${ident(op.table)} SET ${setCols.map((c, i) => `${ident(c)} = $${i + 1}`).join(", ")} WHERE ${keyCols.map((c, i) => `${ident(c)} = $${setCols.length + i + 1}`).join(" AND ")}`;
    await client.query(sql, [...setCols.map((c) => op.set[c]), ...keyCols.map((c) => op.key[c])]);
    return;
  }
  const cols = Object.keys(op.row);
  const key = KEYS[op.table];
  if (!key) throw new Error(`no conflict key for ${op.table}`);
  const update = cols.filter((c) => !key.includes(c));
  const onConflict = op.kind === "insert" || update.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${update.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(", ")}`;
  const sql = `INSERT INTO ${ident(op.table)} (${cols.map(ident).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT (${key.map(ident).join(", ")}) ${onConflict}`;
  await client.query(sql, cols.map((c) => op.row[c]));
}

async function insertLog(client: pg.PoolClient, l: DecodedLog): Promise<boolean> {
  const r = logRow(l);
  const cols = Object.keys(r);
  const res = await client.query(
    `INSERT INTO logs (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
    cols.map((c) => r[c]),
  );
  return res.rowCount === 1;
}

export class PgStore implements IndexStore {
  async checkpoint(chainId: number, settlement: string): Promise<Checkpoint | null> {
    const res = await db().query("SELECT from_block, last_block, last_hash FROM indexer_state WHERE chain_id = $1 AND settlement = $2", [chainId, settlement]);
    const r = res.rows[0];
    return r ? {chainId, settlement, fromBlock: BigInt(r.from_block), lastBlock: BigInt(r.last_block), lastHash: r.last_hash} : null;
  }

  async commit(w: StepWrite): Promise<void> {
    const {chainId, settlement} = w.checkpoint;
    await inTransaction(async (client) => {
      for (const l of w.logs) {
        // Projected only on first sight, so a second pass over a range changes nothing.
        if (!(await insertLog(client, l))) continue;
        for (const op of project(l)) await applyPg(client, op);
      }
      for (const u of w.undecoded) {
        await client.query(
          "INSERT INTO undecoded_logs (chain_id, deployment, block_number, tx_hash, log_index, address, topics, data, error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING",
          [chainId, settlement, String(u.blockNumber), u.txHash, u.logIndex, u.address, JSON.stringify(u.topics), u.data, u.error],
        );
      }
      for (const op of w.extra) await applyPg(client, op);
      for (const b of w.blocks) {
        await client.query(
          "INSERT INTO chain_blocks (chain_id, deployment, number, hash, parent_hash, timestamp) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (chain_id, deployment, number) DO UPDATE SET hash = EXCLUDED.hash, parent_hash = EXCLUDED.parent_hash, timestamp = EXCLUDED.timestamp",
          [chainId, settlement, String(b.number), b.hash, b.parentHash, String(b.timestamp)],
        );
      }
      await client.query(
        "INSERT INTO indexer_state (chain_id, settlement, from_block, last_block, last_hash, updated_at) VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (chain_id, settlement) DO UPDATE SET last_block = EXCLUDED.last_block, last_hash = EXCLUDED.last_hash, updated_at = now()",
        [chainId, settlement, String(w.checkpoint.fromBlock), String(w.checkpoint.lastBlock), w.checkpoint.lastHash],
      );
    });
  }

  async storedBlocks(chainId: number, settlement: string, atOrBelow: bigint, limit: number) {
    const res = await db().query("SELECT number, hash FROM chain_blocks WHERE chain_id = $1 AND deployment = $2 AND number <= $3 ORDER BY number DESC LIMIT $4", [chainId, settlement, String(atOrBelow), limit]);
    return res.rows.map((r) => ({number: BigInt(r.number), hash: r.hash as string}));
  }

  async rewind(c: Checkpoint): Promise<void> {
    await inTransaction(async (client) => {
      const above = [c.settlement, String(c.lastBlock)];
      await client.query("DELETE FROM logs WHERE deployment = $1 AND block_number > $2", above);
      await client.query("DELETE FROM undecoded_logs WHERE deployment = $1 AND block_number > $2", above);
      await client.query("DELETE FROM batch_solutions WHERE deployment = $1 AND block_number > $2", above);
      await client.query("DELETE FROM chain_blocks WHERE chain_id = $1 AND deployment = $2 AND number > $3", [c.chainId, ...above]);
      for (const table of DOMAIN_TABLES) await client.query(`DELETE FROM ${ident(table)} WHERE deployment = $1`, [c.settlement]);
      const remaining = await client.query("SELECT * FROM logs WHERE deployment = $1 ORDER BY block_number, log_index", [c.settlement]);
      for (const r of remaining.rows) for (const op of project(fromLogRow(r))) await applyPg(client, op);
      await client.query("UPDATE indexer_state SET last_block = $3, last_hash = $4, updated_at = now() WHERE chain_id = $1 AND settlement = $2", [c.chainId, c.settlement, String(c.lastBlock), c.lastHash]);
    });
  }

  async count(table: string, deployment: string): Promise<number> {
    const res = await db().query(`SELECT count(*)::int AS n FROM ${ident(table)} WHERE deployment = $1`, [deployment]);
    return res.rows[0].n as number;
  }
}
