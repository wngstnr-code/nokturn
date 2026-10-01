// The auction tables against a real auction, driven by the keeper on the
// closing session fork. I9 cannot fill them, because the batch fork stands in a
// weekend and no auction ever opens there.
//
// Needs make keeper-fork and make db-up. Against the batch fork every case
// skips. Each case runs inside evm_snapshot and is reverted, and the tests use
// their own database, created fresh at the start.
//
// Local signers on a fork of mainnet 4663. Real pool, real token, real feed.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {after, before, describe, test} from "node:test";
import pg from "pg";
import {parseEventLogs, type Abi, type Address, type Hex, type Log, type PublicClient} from "viem";
import type {HDAccount} from "viem/accounts";
import {STOCK_TOKENS} from "../../../packages/shared/addresses.ts";
import {runKeeper} from "../../../solver/src/keeper.ts";
import {commitAuction, fillAuctionBook, users} from "../../../solver/test/fork/lib.ts";
import {REPO_ROOT, loadAbi} from "../../src/abi.ts";

const ADMIN_URL = process.env.NOKTURN_DATABASE_ADMIN_URL ?? "postgres://nokturn:nokturn@127.0.0.1:5440/nokturn";
const TEST_DB = "nokturn_fork_auction_test";
process.env.NOKTURN_DATABASE_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);

// Imported after the database url is set, because db.ts reads it at import.
const {closeDb, db, migrate} = await import("../../src/db.ts");
const {Ingest} = await import("../../src/ingest.ts");
const {PgStore} = await import("../../src/store.ts");
const {client, loadDeployment} = await import("../../src/index.ts");

const AUCTION_CLOSE = 4;
const PHASE = {FROZEN: 2, CROSSED: 3, EXECUTED: 4, ABORTED: 5};
const NVDA = STOCK_TOKENS.NVDA as Address;
const houseAbi: Abi = loadAbi("AuctionHouse");
const sessionAbi: Abi = loadAbi("SessionManager");
const WAD = 10n ** 18n;

let c: PublicClient;
let deployment: Awaited<ReturnType<typeof loadDeployment>>;
let house: Address;
let oracle: Address;
let sessions: Address;
let people: HDAccount[] = [];
let skip: string | false = false;
let nonce = 950_000n;
const nextNonce = () => (nonce += 1n);
const results: Record<string, unknown> = {};

const rpc = (method: string, params: unknown[] = []) => c.request({method: method as never, params: params as never});
const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => c.readContract({address, abi, functionName, args}) as Promise<T>;
const now = async () => (await c.getBlock()).timestamp;

async function warp(to: bigint): Promise<void> {
  await rpc("evm_setNextBlockTimestamp", [Number(to)]);
  await rpc("evm_mine");
}

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function auctionId(): Promise<bigint> {
  const crossAt = await read<bigint>(sessions, sessionAbi, "nextTransition", [await now()]);
  const d = new Date(Number(crossAt) * 1000);
  return read<bigint>(house, houseAbi, "auctionIdOf", [NVDA, d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(), 1]);
}

async function state(id: bigint): Promise<{phase: number; extensions: number}> {
  const s = await read<[Address, number, number, number, number, number]>(house, houseAbi, "auctionState", [id]);
  return {phase: Number(s[2]), extensions: Number(s[5])};
}

async function withKeeper(drive: () => Promise<void>): Promise<void> {
  let done = false;
  const running = runKeeper({log: () => {}, stopWhen: () => done});
  try {
    await drive();
  } finally {
    done = true;
    await running;
  }
}

async function inSnapshot(fn: () => Promise<void>): Promise<void> {
  const id = (await rpc("evm_snapshot")) as Hex;
  try {
    await fn();
  } finally {
    await rpc("evm_revert", [id]);
  }
}

/** A fresh database indexed up to head, then the rows about one auction. */
async function indexed(id: bigint) {
  const admin = new pg.Client({connectionString: ADMIN_URL});
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  await closeDb();
  await migrate();
  const ingest = new Ingest(c, new PgStore(), deployment);
  const head = await c.getBlockNumber();
  for (let i = 0; ; i += 1) {
    if ((await ingest.step()).to >= head) break;
    if (i > 200) throw new Error("did not catch up in two hundred steps");
  }
  const one = async (sql: string, args: unknown[]) => (await db().query(sql, args)).rows;
  return {
    auction: (await one("SELECT * FROM auctions WHERE auction_id = $1", [String(id)]))[0],
    indicative: (await one("SELECT count(*)::int AS n FROM indicative WHERE auction_id = $1", [String(id)]))[0].n as number,
    withheld: await one("SELECT * FROM closing_prints_withheld WHERE lower(token) = lower($1)", [NVDA]),
    prints: await one("SELECT * FROM closing_prints WHERE lower(token) = lower($1)", [NVDA]),
  };
}

async function onChain(id: bigint, fromBlock: bigint): Promise<string[]> {
  const logs = await c.getLogs({address: house, fromBlock, toBlock: "latest"});
  return parseEventLogs({abi: houseAbi, logs: logs as Log[], strict: false})
    .filter((l) => (l.args as {auctionId?: bigint}).auctionId === id)
    .map((l) => l.eventName as string);
}

describe("auction tables on the closing session fork", () => {
  before(async () => {
    c = client();
    deployment = await loadDeployment(c);
    house = (JSON.parse(readFileSync(join(REPO_ROOT, "infra", "fork-deployment.json"), "utf8")) as {auctionHouse: Address}).auctionHouse;
    oracle = await read<Address>(house, houseAbi, "oracle");
    sessions = await read<Address>(house, houseAbi, "sessions");
    const session = await read<number>(sessions, sessionAbi, "sessionAt", [await now()]);
    if (session !== AUCTION_CLOSE) {
      skip = `the fork stands in session ${session}, not AUCTION_CLOSE. run make keeper-fork`;
      return;
    }
    people = users();
  });

  after(async () => {
    console.log(skip ? `skipped: ${skip}` : `A results\n${JSON.stringify(results, (_, v) => (typeof v === "bigint" ? String(v) : v), 2)}`);
    await closeDb();
  });

  test("A1 a crossed closing auction, its indicatives and the withheld print", async (t) => {
    if (skip) return t.skip(skip);
    await inSnapshot(async () => {
      const from = await c.getBlockNumber();
      await fillAuctionBook(c, house, oracle, NVDA, people, nextNonce);
      const id = await auctionId();
      const [, crossAt] = await read<[bigint, bigint, bigint]>(house, houseAbi, "auctionTiming", [id]);
      await withKeeper(async () => {
        await waitFor("frozen", async () => (await state(id)).phase === PHASE.FROZEN);
        await waitFor("an indicative after the freeze", async () => (await onChain(id, from)).includes("IndicativePublished"));
        await warp(crossAt);
        await waitFor("crossed", async () => (await state(id)).phase === PHASE.CROSSED);
        await warp(crossAt + 121n);
        await waitFor("executed", async () => (await state(id)).phase === PHASE.EXECUTED);
      });

      const [, price, matched, , participants] = await read<[bigint, bigint, bigint, bigint, number]>(house, houseAbi, "auctionResult", [id]);
      const quoteVolume = (matched * price) / WAD;
      const names = await onChain(id, from);
      const rows = await indexed(id);
      results.A1 = {id, price, quoteVolume, participants, indicativeOnChain: names.filter((n) => n === "IndicativePublished").length, row: rows.auction, indicativeRows: rows.indicative, withheld: rows.withheld, prints: rows.prints.length};

      assert.equal(rows.auction.status, "crossed");
      assert.equal(rows.auction.price, String(price));
      assert.equal(rows.auction.volume, String(quoteVolume));
      assert.equal(rows.auction.participants, Number(participants));
      assert.equal(rows.indicative, names.filter((n) => n === "IndicativePublished").length);
      assert.ok(rows.indicative > 0, "the keeper published no indicative");
      // About $455 from four owners. _publishPrint checks the volume first, so
      // that is the reason named, though the owners are one short as well.
      assert.ok(quoteVolume < 1_000n * 10n ** 6n);
      assert.equal(rows.prints.length, 0);
      assert.equal(rows.withheld.length, 1);
      assert.equal(rows.withheld[0].volume, String(quoteVolume));
      assert.equal(rows.withheld[0].participants, Number(participants));
      assert.equal(rows.withheld[0].reason, "volume below minimum");
    });
  });

  test("A2 an auction with nothing to match is extended three times and aborted", async (t) => {
    if (skip) return t.skip(skip);
    await inSnapshot(async () => {
      await commitAuction(c, house, people[0]!, NVDA, true, 1_234_567_890_123_456_789n, nextNonce());
      const id = await auctionId();
      const [, , referenceAt] = await read<[bigint, bigint, bigint]>(house, houseAbi, "auctionTiming", [id]);
      await withKeeper(async () => {
        await waitFor("frozen", async () => (await state(id)).phase === PHASE.FROZEN);
        for (let k = 1; k <= 3; k += 1) {
          await warp(referenceAt + 300n * BigInt(k));
          await waitFor(`extension ${k}`, async () => (await state(id)).extensions === k);
        }
        await warp(referenceAt + 1_201n);
        await waitFor("aborted", async () => (await state(id)).phase === PHASE.ABORTED);
      });

      const rows = await indexed(id);
      results.A2 = {id, row: rows.auction};
      assert.equal(rows.auction.status, "aborted");
      assert.equal(rows.auction.extensions, 3);
      assert.equal(rows.auction.abort_reason, "no cross in time");
      assert.equal(rows.auction.price, null);
    });
  });
});
