// The Postgres connection and the migration runner.
//
// The pool is created on first use, so a process that only imports this module,
// the API among them, starts even when the database is down.

import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import pg from "pg";
import {REPO_ROOT} from "./abi.ts";

export const DATABASE_URL = process.env.NOKTURN_DATABASE_URL ?? "postgres://nokturn:nokturn@127.0.0.1:5433/nokturn";
const SQL_DIR = join(REPO_ROOT, "indexer", "sql");

// numeric(78,0) comes back as a string by default, which is what every caller
// wants, because BigInt(string) is lossless and Number would not be.
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

let pool: pg.Pool | null = null;

export function db(opts: {readOnly?: boolean} = {}): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 3_000,
    // The API reads and never writes, and the database enforces that.
    options: opts.readOnly ? "-c default_transaction_read_only=on" : undefined,
  });
  // An idle client that loses its server emits here. Without a listener that is
  // an uncaught exception, and the process dies with the database.
  pool.on("error", () => {});
  return pool;
}

export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end();
}

export async function inTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Applies every sql/NNN_*.sql file not yet recorded, each exactly once, each in its own transaction. */
export async function migrate(): Promise<string[]> {
  await db().query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await db().query<{version: string}>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
  const files = readdirSync(SQL_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    await inTransaction(async (client) => {
      await client.query(readFileSync(join(SQL_DIR, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    });
    ran.push(file);
  }
  return ran;
}
