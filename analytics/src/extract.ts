// F29. One hour of real August 2026 trades, exported from Dune query 13, into
// the fixture the replay harness signs again with local keys.
//
//   node analytics/src/extract.ts --csv data/replay/<export>.csv --query-id <id> [--cap-usd <n> --batch-seconds <n>]
//
// With the fork up, the batch cap and the batch length are read from it for the
// session the fork is in now, so the fixture fits the batches it will be played
// into. --cap-usd and --batch-seconds are for when no fork is running, and then
// the cap given is taken as the cap one batch actually has.
//
// Nothing is generated. Every trade in the fixture is a row of the export, in
// its order, with its time offset, side, token and size, and carries its tx hash
// and log index so it can be looked up on the chain. The only change is scale,
// and the factor is written into the file next to the original sizes.

import {readFileSync, writeFileSync} from "node:fs";
import {dirname, join, relative} from "node:path";
import {fileURLToPath} from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SQL_FILE = "data/dune-queries/13-replay-flow-august.sql";
/** The aggregate queries the replay's netting is compared against, never the source of a trade. */
export const AGGREGATE_QUERIES = ["8595251", "8595303"];
export const ALLOWLIST = ["NVDA", "AAPL", "TSLA", "GOOGL"] as const;
/** The backtest's off-hours batch length, used only when no fork says otherwise. */
export const DEFAULT_BATCH_SECONDS = 45;
/** Session.CLOSED_WEEKEND, HOLIDAY and PROTECTIVE in contracts/src/types/Types.sol. */
const HALVED_SESSIONS = new Set([6, 7, 8]);
/**
 * The busiest window is scaled to this share of capPerBatchUsd rather than to
 * the cap itself, because prices move between extraction and replay and a batch
 * at exactly the cap would fail on the first tick up.
 */
export const CAP_HEADROOM_BPS = 9_000n;

export interface FixtureTrade {
  /** Seconds from the start of the window. */
  at: number;
  window: number;
  sym: (typeof ALLOWLIST)[number];
  side: "buy" | "sell";
  /** USD in 6 decimals, after scaling. */
  usdMicro: string;
  usdMicroOriginal: string;
  /** Index of the taker in order of first appearance. The address itself is not kept. */
  trader: number;
  txHash: string;
  logIndex: number;
}

export interface Fixture {
  source: {
    queryId: string;
    sql: string;
    aggregateQueries: string[];
    extractedAt: string;
    windowStart: string;
    windowEnd: string;
    sourceTrades: number;
    statement: string;
  };
  scale: {
    /** The cap one batch has in `session`, which is what the busiest window is scaled under. */
    capPerBatchUsdMicro: string;
    /** capPerBatchUsd() before the session halves it. Null when no fork was read. */
    fullCapPerBatchUsdMicro: string | null;
    /** The fork's session at extraction. Null when no fork was read. */
    session: number | null;
    headroomBps: string;
    busiestWindowUsdMicro: string;
    numerator: string;
    denominator: string;
    factor: string;
  };
  batchSeconds: number;
  traders: number;
  trades: FixtureTrade[];
}

/** RFC 4180 enough for a Dune export, quoted fields with doubled quotes inside. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/** Dune writes "2026-08-12 03:00:01.000 UTC". */
export function parseDuneTime(s: string): number {
  const iso = s.trim().replace(" UTC", "Z").replace(" ", "T");
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`cannot read the time ${s}`);
  return ms;
}

/** A decimal string to 6 decimal integer, truncated, never through a float. */
export function toMicro(s: string): bigint {
  const t = s.trim();
  if (!/^\d+(\.\d+)?(e[+-]?\d+)?$/i.test(t)) throw new Error(`not a usd amount ${s}`);
  if (/e/i.test(t)) {
    // Dune sometimes writes large floats in exponent form. A float is already
    // what it gave us, so reading it as one loses nothing further.
    return BigInt(Math.floor(Number(t) * 1e6));
  }
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

const REQUIRED = ["block_time", "tx_hash", "evt_index", "sym", "side", "amount_usd", "taker", "window_start"];

/** Settlement._capScale applied to capPerBatchUsd, in 6 decimals. */
export function batchCapUsdMicro(fullCapUsdMicro: bigint, session: number): bigint {
  return HALVED_SESSIONS.has(session) ? fullCapUsdMicro / 2n : fullCapUsdMicro;
}

export interface ExtractOptions {
  queryId: string;
  capPerBatchUsdMicro: bigint;
  batchSeconds?: number;
  fullCapPerBatchUsdMicro?: bigint;
  session?: number;
  extractedAt?: string;
}

export function extract(rows: Record<string, string>[], opts: ExtractOptions): Fixture {
  if (rows.length === 0) throw new Error("the export has no rows");
  const missing = REQUIRED.filter((k) => !(k in rows[0]!));
  if (missing.length) throw new Error(`the export lacks ${missing.join(", ")}. is it query 13`);
  const batchSeconds = opts.batchSeconds ?? DEFAULT_BATCH_SECONDS;
  const start = parseDuneTime(rows[0]!.window_start!);
  const traders = new Map<string, number>();

  const base = rows.map((r) => {
    const sym = r.sym!.trim() as FixtureTrade["sym"];
    if (!ALLOWLIST.includes(sym)) throw new Error(`${sym} is outside allowlist v1.0`);
    const side = r.side!.trim();
    if (side !== "buy" && side !== "sell") throw new Error(`side ${side} is neither buy nor sell`);
    const at = Math.floor((parseDuneTime(r.block_time!) - start) / 1000);
    if (at < 0 || at >= 3600) throw new Error(`${r.tx_hash} at ${r.block_time} is outside the window starting ${r.window_start}`);
    const taker = r.taker!.trim().toLowerCase();
    if (!traders.has(taker)) traders.set(taker, traders.size);
    return {at, window: Math.floor(at / batchSeconds), sym, side: side as "buy" | "sell", usd: toMicro(r.amount_usd!), trader: traders.get(taker)!, txHash: r.tx_hash!.trim().toLowerCase(), logIndex: Number(r.evt_index)};
  });

  const perWindow = new Map<number, bigint>();
  for (const t of base) perWindow.set(t.window, (perWindow.get(t.window) ?? 0n) + t.usd);
  const busiest = [...perWindow.values()].reduce((a, b) => (b > a ? b : a), 0n);
  const target = (opts.capPerBatchUsdMicro * CAP_HEADROOM_BPS) / 10_000n;
  // Never scaled up. A window already under the cap is replayed at its real size.
  const [num, den] = busiest > target ? [target, busiest] : [1n, 1n];

  const trades: FixtureTrade[] = base.map((t) => ({
    at: t.at,
    window: t.window,
    sym: t.sym,
    side: t.side,
    usdMicro: String((t.usd * num) / den),
    usdMicroOriginal: String(t.usd),
    trader: t.trader,
    txHash: t.txHash,
    logIndex: t.logIndex,
  }));

  return {
    source: {
      queryId: opts.queryId,
      sql: SQL_FILE,
      aggregateQueries: AGGREGATE_QUERIES,
      extractedAt: opts.extractedAt ?? new Date().toISOString(),
      windowStart: new Date(start).toISOString(),
      windowEnd: new Date(start + 3_600_000).toISOString(),
      sourceTrades: rows.length,
      statement: `Real trade shape from Dune query ${opts.queryId}, one off-hours hour of August 2026 on Robinhood Chain, NVDA AAPL TSLA GOOGL against canonical USDG. The replay signs it again with local keys on a fork of mainnet 4663, so the traders are not the original ones and nothing reaches mainnet.`,
    },
    scale: {
      capPerBatchUsdMicro: String(opts.capPerBatchUsdMicro),
      fullCapPerBatchUsdMicro: opts.fullCapPerBatchUsdMicro === undefined ? null : String(opts.fullCapPerBatchUsdMicro),
      session: opts.session ?? null,
      headroomBps: String(CAP_HEADROOM_BPS),
      busiestWindowUsdMicro: String(busiest),
      numerator: String(num),
      denominator: String(den),
      factor: (Number((num * 1_000_000n) / den) / 1e6).toFixed(6),
    },
    batchSeconds,
    traders: traders.size,
    trades,
  };
}

interface ForkLimits {
  capPerBatchUsdMicro: bigint;
  fullCapPerBatchUsdMicro: bigint;
  session: number;
  batchSeconds: number;
}

async function limitsFromFork(): Promise<ForkLimits> {
  const {createPublicClient, http} = await import("viem");
  const record = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "fork-deployment.json"), "utf8")) as {settlement: `0x${string}`; sessions: `0x${string}`};
  const abi = (name: string) => JSON.parse(readFileSync(join(REPO_ROOT, "packages", "shared", "abi", `${name}.json`), "utf8"));
  const c = createPublicClient({transport: http(process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545")});
  const block = await c.getBlock();
  const at = {blockNumber: block.number};
  // 1e18 USD in the contract, 1e6 here.
  const full = ((await c.readContract({address: record.settlement, abi: abi("Settlement"), functionName: "capPerBatchUsd", ...at})) as bigint) / 10n ** 12n;
  const session = Number(await c.readContract({address: record.sessions, abi: abi("SessionManager"), functionName: "sessionAt", args: [block.timestamp], ...at}));
  const batchSeconds = Number(await c.readContract({address: record.sessions, abi: abi("SessionManager"), functionName: "batchDuration", args: [session], ...at}));
  if (batchSeconds === 0) throw new Error(`the fork is in auction session ${session}, which runs no ordinary batch. extract again once it has moved on`);
  return {capPerBatchUsdMicro: batchCapUsdMicro(full, session), fullCapPerBatchUsdMicro: full, session, batchSeconds};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const csv = flag("--csv");
  const queryId = flag("--query-id");
  const capUsd = flag("--cap-usd");
  const batchSeconds = flag("--batch-seconds");
  if (!csv || !queryId || !/^\d+$/.test(queryId) || Boolean(capUsd) !== Boolean(batchSeconds)) {
    console.error("usage: node analytics/src/extract.ts --csv <export.csv> --query-id <dune id> [--cap-usd <n> --batch-seconds <n>]");
    process.exit(2);
  }
  const limits: Promise<Pick<ExtractOptions, "capPerBatchUsdMicro" | "batchSeconds" | "fullCapPerBatchUsdMicro" | "session">> =
    capUsd && batchSeconds ? Promise.resolve({capPerBatchUsdMicro: BigInt(capUsd) * 1_000_000n, batchSeconds: Number(batchSeconds)}) : limitsFromFork();
  limits
    .then((l) => {
      const fixture = extract(parseCsv(readFileSync(csv, "utf8")), {queryId, ...l});
      const out = join(REPO_ROOT, "data", "replay", "august-2026.json");
      writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
      const where = l.session === undefined ? "given on the command line" : `session ${l.session} on the fork`;
      console.log(`${fixture.trades.length} trades from query ${queryId}, ${fixture.traders} traders, window ${fixture.source.windowStart}, batch cap ${Number(l.capPerBatchUsdMicro) / 1e6} usd over ${fixture.batchSeconds}s from ${where}, scale ${fixture.scale.factor}, written to ${relative(REPO_ROOT, out)}`);
    })
    .catch((error) => {
      console.error(`extract failed\n  ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
