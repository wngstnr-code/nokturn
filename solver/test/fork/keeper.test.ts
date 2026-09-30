// K1 to K3 from docs/rencana-hari6-7.md, phase G3.
//
// Needs the closing session fork, which make keeper-fork starts at block
// 66,491,729 with the clock frozen. Against the batch fork every case skips,
// because that fork stands in a weekend and warping it to a close leaves every
// feed stale (N17). Each case runs inside evm_snapshot and is reverted.
//
// Local signers on a fork of mainnet 4663. Real pool, real token, real feed.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {after, before, describe, test} from "node:test";
import {encodeFunctionData, parseEventLogs, type Abi, type Address, type Hex, type Log} from "viem";
import type {HDAccount} from "viem/accounts";
import {witnessDigest, type DecodedIntent} from "../../../api/src/permit2.ts";
import {PERMIT2, STOCK_TOKENS, USDG} from "../../../packages/shared/addresses.ts";
import {REPO_ROOT, loadAbi, oracleAbi, sessionAbi} from "../../src/abi.ts";
import {client} from "../../src/chain.ts";
import {quoteOf} from "../../src/cross.ts";
import {runKeeper} from "../../src/keeper.ts";
import {users} from "./lib.ts";

const AUCTION_CLOSE = 4;
const PHASE = {DISCLOSURE: 1, FROZEN: 2, CROSSED: 3, EXECUTED: 4, ABORTED: 5};
const FLAG_AUCTION = 1 << 2;
const SESSION_MASK_AUCTION_CLOSE = 1 << 4;
const MOO = 1;
const NVDA = STOCK_TOKENS.NVDA as Address;

const c = client();
const record = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "fork-deployment.json"), "utf8")) as {auctionHouse: Address; sessions: Address; oracle: Address};
const house = record.auctionHouse;
const houseAbi: Abi = loadAbi("AuctionHouse");
const rpc = (method: string, params: unknown[] = []) => c.request({method: method as never, params: params as never});
const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => c.readContract({address, abi, functionName, args}) as Promise<T>;

let skip: string | false = false;
let people: HDAccount[] = [];
let nonce = 900_000n;

async function now(): Promise<bigint> {
  return (await c.getBlock()).timestamp;
}

async function warp(to: bigint): Promise<void> {
  await rpc("evm_setNextBlockTimestamp", [Number(to)]);
  await rpc("evm_mine");
}

async function waitFor<T>(what: string, probe: () => Promise<T | null>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got !== null) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function commit(user: HDAccount, sell: boolean, amount: bigint): Promise<void> {
  const intent: DecodedIntent = {
    owner: user.address,
    receiver: user.address,
    sellToken: sell ? NVDA : (USDG as Address),
    buyToken: sell ? (USDG as Address) : NVDA,
    sellAmount: amount,
    minBuyAmount: 1n,
    validAfter: 0,
    validUntil: Number((await now()) + 7_200n),
    flags: FLAG_AUCTION,
    kind: MOO,
    maxDevFromRefBps: 0,
    allowedSessions: SESSION_MASK_AUCTION_CLOSE,
    batchSpan: 1,
    nonce: (nonce += 1n),
  };
  const [domainSeparator, witnessTypeString] = await Promise.all([
    read<Hex>(PERMIT2, loadAbi("ISignatureTransfer"), "DOMAIN_SEPARATOR"),
    read<string>(house, houseAbi, "WITNESS_TYPE_STRING"),
  ]);
  const sig = await user.sign({hash: witnessDigest({domainSeparator, witnessTypeString, intent, spender: house})});
  const data = encodeFunctionData({abi: houseAbi, functionName: "commitAuctionIntent", args: [intent, sig]});
  const hash = (await rpc("eth_sendTransaction", [{from: user.address, to: house, data}])) as Hex;
  const receipt = await c.waitForTransactionReceipt({hash});
  assert.equal(receipt.status, "success", `commit by ${user.address} reverted`);
}

/**
 * Two sellers with odd amounts and three buyers who together bring half a
 * percent more than the sellers' tokens are worth at the reference. That is the
 * side the contract's own price cannot cross, so it exercises the balancing.
 */
async function fillBook(): Promise<void> {
  const [ref] = await read<[bigint, bigint, boolean]>(record.oracle, oracleAbi(), "refPrice", [NVDA]);
  const price = (ref * 10n ** 6n) / 10n ** 18n;
  const sells = [1_234_567_890_123_456_789n, 800_000_000_000_000_001n];
  await commit(people[0]!, true, sells[0]!);
  await commit(people[1]!, true, sells[1]!);
  const worth = (quoteOf(sells[0]! + sells[1]!, price) * 1_005n) / 1_000n;
  await commit(people[2]!, false, worth / 3n + 17n);
  await commit(people[3]!, false, worth / 3n - 11n);
  await commit(people[2]!, false, worth - 2n * (worth / 3n) - 6n);
}

async function auctionId(): Promise<bigint> {
  const crossAt = await read<bigint>(record.sessions, sessionAbi(), "nextTransition", [await now()]);
  const d = new Date(Number(crossAt) * 1000);
  const ymd = d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  return read<bigint>(house, houseAbi, "auctionIdOf", [NVDA, ymd, 1]);
}

async function state(id: bigint): Promise<{phase: number; extensions: number}> {
  const s = await read<[Address, number, number, number, number, number]>(house, houseAbi, "auctionState", [id]);
  return {phase: Number(s[2]), extensions: Number(s[5])};
}

async function timing(id: bigint): Promise<{freezeAt: bigint; crossAt: bigint; referenceAt: bigint}> {
  const [freezeAt, crossAt, referenceAt] = await read<[bigint, bigint, bigint]>(house, houseAbi, "auctionTiming", [id]);
  return {freezeAt, crossAt, referenceAt};
}

/**
 * The keeper opens an auction for every allowed token, not only the one the
 * test committed to, so a count over all of AuctionHouse is five times too big.
 */
async function eventsSince(fromBlock: bigint, auctionId: bigint): Promise<string[]> {
  const logs = await c.getLogs({address: house, fromBlock, toBlock: "latest"});
  return parseEventLogs({abi: houseAbi, logs: logs as Log[], strict: false})
    .filter((l) => (l.args as {auctionId?: bigint}).auctionId === auctionId)
    .map((l) => l.eventName as string);
}

const count = (names: string[], name: string) => names.filter((n) => n === name).length;

async function inSnapshot(fn: () => Promise<void>): Promise<void> {
  const id = await rpc("evm_snapshot");
  try {
    await fn();
  } finally {
    await rpc("evm_revert", [id]);
  }
}

/** Runs the keeper until done() is true, driving chain time with drive(). */
async function withKeeper(drive: () => Promise<void>, lines: string[]): Promise<void> {
  let done = false;
  const running = runKeeper({log: (l) => lines.push(l), stopWhen: () => done});
  try {
    await drive();
  } finally {
    done = true;
    await running;
  }
}

describe("auction keeper, K1 to K3", () => {
  before(async () => {
    const session = await read<number>(record.sessions, sessionAbi(), "sessionAt", [await now()]);
    if (session !== AUCTION_CLOSE) {
      skip = `the fork stands in session ${session}, not AUCTION_CLOSE. run make keeper-fork`;
      return;
    }
    people = users();
  });

  after(() => {
    if (skip) console.log(`skipped: ${skip}`);
  });

  test("K1 one full cycle for one token", async (t) => {
    if (skip) return t.skip(skip);
    await inSnapshot(async () => {
      const from = await c.getBlockNumber();
      await fillBook();
      const id = await auctionId();
      assert.notEqual(id, 0n, "the commits did not create an auction");
      const {crossAt} = await timing(id);
      const lines: string[] = [];

      await withKeeper(async () => {
        await waitFor("frozen", async () => ((await state(id)).phase === PHASE.FROZEN ? true : null));
        await waitFor("an indicative after the freeze", async () => (count(await eventsSince(from, id), "IndicativePublished") > 0 ? true : null));
        await warp(crossAt);
        await waitFor("crossed", async () => ((await state(id)).phase === PHASE.CROSSED ? true : null));
        await warp(crossAt + 121n);
        await waitFor("executed", async () => ((await state(id)).phase === PHASE.EXECUTED ? true : null));
      }, lines);

      const names = await eventsSince(from, id);
      assert.equal(count(names, "AuctionOpened"), 1, lines.join("\n"));
      assert.ok(count(names, "IndicativePublished") >= 1);
      assert.equal(count(names, "AuctionFrozen"), 1);
      assert.equal(count(names, "CommitmentDropped"), 0);
      assert.equal(count(names, "CrossSubmitted"), 1);
      assert.equal(count(names, "CrossExecuted"), 1);
    });
  });

  test("K2 a book with nothing to match extends three times and then aborts", async (t) => {
    if (skip) return t.skip(skip);
    await inSnapshot(async () => {
      const from = await c.getBlockNumber();
      await commit(people[0]!, true, 1_234_567_890_123_456_789n);
      await commit(people[1]!, true, 800_000_000_000_000_001n);
      const id = await auctionId();
      const {referenceAt} = await timing(id);
      const lines: string[] = [];

      await withKeeper(async () => {
        await waitFor("frozen", async () => ((await state(id)).phase === PHASE.FROZEN ? true : null));
        for (let k = 1; k <= 3; k += 1) {
          await warp(referenceAt + 300n * BigInt(k));
          await waitFor(`extension ${k}`, async () => ((await state(id)).extensions === k ? true : null));
        }
        await warp(referenceAt + 1_201n);
        await waitFor("aborted", async () => ((await state(id)).phase === PHASE.ABORTED ? true : null));
      }, lines);

      const names = await eventsSince(from, id);
      assert.equal(count(names, "AuctionExtended"), 3, lines.join("\n"));
      assert.equal(count(names, "AuctionAborted"), 1);
      assert.equal(count(names, "CrossSubmitted"), 0);
      assert.ok(lines.some((l) => l.includes("no cross yet")), "the keeper never said why it could not cross");
    });
  });

  test("K3 a keeper stopped mid cycle is picked up by a new one without repeating anything", async (t) => {
    if (skip) return t.skip(skip);
    await inSnapshot(async () => {
      const from = await c.getBlockNumber();
      await fillBook();
      const id = await auctionId();
      const {crossAt} = await timing(id);
      const first: string[] = [];
      const second: string[] = [];

      await withKeeper(async () => {
        await waitFor("frozen", async () => ((await state(id)).phase === PHASE.FROZEN ? true : null));
      }, first);

      await withKeeper(async () => {
        await warp(crossAt);
        await waitFor("crossed", async () => ((await state(id)).phase === PHASE.CROSSED ? true : null));
        await warp(crossAt + 121n);
        await waitFor("executed", async () => ((await state(id)).phase === PHASE.EXECUTED ? true : null));
      }, second);

      const names = await eventsSince(from, id);
      for (const once of ["AuctionOpened", "AuctionFrozen", "CrossSubmitted", "CrossExecuted"]) {
        assert.equal(count(names, once), 1, `${once} ${count(names, once)} times\n${first.join("\n")}\n---\n${second.join("\n")}`);
      }
    });
  });
});
