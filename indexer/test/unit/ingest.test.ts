import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {stringToHex} from "viem";
import {confirmationsFor, UnsafeConfirmations} from "../../src/index.ts";
import {Ingest, RangeRefused, rangeRefused} from "../../src/ingest.ts";
import {MemoryStore} from "../../src/store.ts";
import {ADDR, DEPLOYMENT, FakeChain} from "./fakechain.ts";

const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const OWNER = "0xc3e87ba4132708838243a717c4b90112271ceee3";
const SOLVER = "0x86d9065c8bc1f0fa29d02ca873523c19c7859f95";
const HASH = `0x${"ab".repeat(32)}` as const;
const r32 = (s: string) => stringToHex(s, {size: 32});

const S = (event: string, args: Record<string, unknown>) => ({contract: "Settlement", address: ADDR.settlement, event, args});

function settledBatch(batchId: bigint) {
  return [
    S("SolutionSubmitted", {batchId, solver: SOLVER, hash: HASH, claimedSavings: 5n}),
    S("ClearingPrice", {batchId, token: NVDA, price: 1010n, refPrice: 1000n}),
    S("IntentSettled", {batchId, owner: OWNER, intentHash: HASH, sellToken: USDG, buyToken: NVDA, executedSell: 100n, executedBuy: 52n, baselineBuy: 50n, savingsUsd: 7n}),
    S("BatchSettled", {batchId, solver: SOLVER, session: 6, intentCount: 1n, nettedVolumeUsd: 30n, routedVolumeUsd: 70n, totalSavingsUsd: 7n, solverFeeUsd: 0n, protocolFeeUsd: 0n}),
  ];
}

async function drain(ingest: Ingest) {
  for (let i = 0; i < 20; i += 1) {
    const r = await ingest.step();
    if (r.to >= (await ingest.c.getBlockNumber())) return;
  }
  throw new Error("did not catch up in twenty steps");
}

describe("ingest", () => {
  test("every event of interfaces.md section 10 decodes into its table", async () => {
    const chain = new FakeChain();
    chain.emit(settledBatch(1_789_893_780n));
    chain.emit([
      S("BatchPassthrough", {batchId: 1_789_893_840n, intentCount: 2n, reason: "intent could not be collected"}),
      S("IntentCollectionFailed", {batchId: 1_789_893_840n, owner: OWNER, intentIndex: 1n}),
      S("BatchPassthrough", {batchId: 1_789_893_900n, intentCount: 0n, reason: "winner never finalized"}),
      S("VenueRouted", {batchId: 1_789_893_780n, adapter: ADDR.oracle, tokenIn: USDG, tokenOut: NVDA, amountIn: 70n, amountOut: 36n}),
    ]);
    chain.emit([
      {contract: "AuctionHouse", address: ADDR.auctionHouse, event: "AuctionOpened", args: {auctionId: 9n, token: NVDA, kind: 1, crossAt: 1_789_900_000n}},
      {contract: "AuctionHouse", address: ADDR.auctionHouse, event: "IndicativePublished", args: {auctionId: 9n, token: NVDA, indicativePrice: 1000n, imbalance: -5n, matchedVolume: 20n}},
      {contract: "AuctionHouse", address: ADDR.auctionHouse, event: "CrossExecuted", args: {auctionId: 9n, token: NVDA, price: 1001n, volume: 20n, participants: 3}},
      {contract: "AuctionHouse", address: ADDR.auctionHouse, event: "ClosingPrintPublished", args: {token: NVDA, day: 20_716, price: 1001n, volume: 20n, participants: 3, sufficient: true}},
      {contract: "AuctionHouse", address: ADDR.auctionHouse, event: "ClosingPrintWithheld", args: {token: USDG, day: 20_716, reason: r32("too few participants"), volume: 1n, participants: 1}},
      {contract: "SolverRegistry", address: ADDR.solvers, event: "SolverScoreUpdated", args: {solver: SOLVER, batchesWon: 1n, savingsGeneratedUsd: 7n}},
      {contract: "SolverRegistry", address: ADDR.solvers, event: "SolverSlashed", args: {solver: SOLVER, amount: 50n, reason: r32("failed finalize")}},
      {contract: "SessionManager", address: ADDR.sessions, event: "SessionChanged", args: {from: 5, to: 6, timestamp: 1_789_890_000n}},
      {contract: "SessionManager", address: ADDR.sessions, event: "TokenProtective", args: {token: NVDA, reason: r32("drift")}},
    ]);
    const store = new MemoryStore();
    await drain(new Ingest(chain.client(), store, DEPLOYMENT));

    const batches = store.rows("batches");
    assert.deepEqual(batches.map((b) => [b.batch_id, b.outcome]).sort(), [["1789893780", "settled"], ["1789893840", "passthrough"], ["1789893900", "expired"]]);
    const settled = batches.find((b) => b.outcome === "settled")!;
    assert.equal(settled.netted_usd, "30");
    assert.equal(settled.solver, SOLVER);
    for (const b of batches) for (const k of ["chain_id", "block_number", "block_timestamp", "tx_hash", "log_index"]) assert.notEqual(b[k], undefined, `batches.${k}`);

    const fill = store.rows("fills")[0]!;
    assert.equal(fill.baseline_buy, "50");
    assert.equal(fill.savings_usd, "7");
    assert.equal(store.rows("prices")[0]!.deviation_bps, "100");
    assert.equal(store.rows("collection_failures")[0]!.owner, OWNER);
    assert.equal(store.rows("venue_routes")[0]!.amount_out, "36");
    assert.equal(store.rows("solutions")[0]!.accepted, true);

    const auction = store.rows("auctions")[0]!;
    assert.equal(auction.status, "crossed");
    assert.equal(auction.price, "1001");
    assert.equal(store.rows("indicative")[0]!.imbalance, "-5");
    assert.equal(store.rows("closing_prints")[0]!.sufficient, true);
    assert.equal(store.rows("closing_prints_withheld")[0]!.reason, "too few participants");
    assert.deepEqual(store.rows("solvers").map((r) => r.event), ["score", "slashed"]);
    assert.equal(store.rows("solvers")[1]!.slash_reason, "failed finalize");
    assert.deepEqual(store.rows("sessions").map((r) => r.kind), ["changed", "protective"]);
    assert.equal(store.rows("undecoded_logs").length, 0);
  });

  test("a routed batch that saved nothing keeps settled and the passthrough note", async () => {
    const chain = new FakeChain();
    chain.emit([S("BatchPassthrough", {batchId: 7n, intentCount: 2n, reason: "savings below threshold"}), ...settledBatch(7n).slice(3)]);
    const store = new MemoryStore();
    await drain(new Ingest(chain.client(), store, DEPLOYMENT));
    const [b] = store.rows("batches");
    assert.equal(b!.outcome, "settled");
    assert.equal(b!.reason, "savings below threshold");
  });

  test("the same range twice leaves the same rows", async () => {
    const chain = new FakeChain();
    chain.emit(settledBatch(1n));
    chain.mine(700);
    chain.emit(settledBatch(2n));
    const store = new MemoryStore();
    const ingest = new Ingest(chain.client(), store, DEPLOYMENT);
    await drain(ingest);
    const counts = () => ["logs", "batches", "fills", "prices", "solutions"].map((t) => store.rows(t).length);
    const first = counts();
    const back = await ingest.checkpoint();
    await store.commit({checkpoint: {...back, lastBlock: 100n, lastHash: (await chain.client().getBlock({blockNumber: 100n})).hash!}, blocks: [], logs: [], undecoded: [], extra: []});
    await drain(ingest);
    assert.deepEqual(counts(), first);
    assert.deepEqual(first, [8, 2, 2, 2, 2]);
  });

  test("getLogs is never asked for more than 500 blocks", async () => {
    const chain = new FakeChain();
    chain.mine(1_234);
    const store = new MemoryStore();
    const ingest = new Ingest(chain.client(), store, DEPLOYMENT);
    const r = await ingest.step();
    assert.equal(r.to - r.from + 1n, 500n);
  });

  test("a revert drops exactly the rows above the common ancestor", async () => {
    const chain = new FakeChain();
    const keep = chain.emit(settledBatch(1n));
    chain.mine(3);
    chain.emit(settledBatch(2n));
    const store = new MemoryStore();
    const ingest = new Ingest(chain.client(), store, DEPLOYMENT);
    await drain(ingest);
    assert.equal(store.rows("batches").length, 2);

    chain.revertTo(keep + 2n);
    chain.emit(settledBatch(3n));
    const r = await ingest.step();
    assert.equal(r.rewoundTo, keep);
    await drain(ingest);
    assert.deepEqual(store.rows("batches").map((b) => b.batch_id).sort(), ["1", "3"]);
    assert.equal(store.rows("fills").length, 2);
    assert.equal(store.rows("logs").length, 8);
  });

  test("an auction updated after the revert point rolls back to its earlier state", async () => {
    const chain = new FakeChain();
    const opened = chain.emit([{contract: "AuctionHouse", address: ADDR.auctionHouse, event: "AuctionOpened", args: {auctionId: 4n, token: NVDA, kind: 1, crossAt: 5n}}]);
    chain.emit([{contract: "AuctionHouse", address: ADDR.auctionHouse, event: "AuctionAborted", args: {auctionId: 4n, reason: r32("no cross")}}]);
    const store = new MemoryStore();
    const ingest = new Ingest(chain.client(), store, DEPLOYMENT);
    await drain(ingest);
    assert.equal(store.rows("auctions")[0]!.status, "aborted");
    chain.revertTo(opened);
    chain.mine();
    await drain(ingest);
    assert.equal(store.rows("auctions")[0]!.status, "open");
    assert.equal(store.rows("auctions")[0]!.abort_reason, undefined);
  });

  test("a block is held back until it is confirmations deep", async () => {
    const chain = new FakeChain();
    const store = new MemoryStore();
    const ingest = new Ingest(chain.client(), store, DEPLOYMENT, () => {}, 2n);
    const at = chain.emit(settledBatch(9n));
    await ingest.step();
    assert.equal(store.rows("fills").length, 0);
    chain.mine();
    await ingest.step();
    assert.equal(store.rows("fills").length, 0);
    chain.mine();
    const r = await ingest.step();
    assert.equal(r.to, at);
    assert.equal(store.rows("fills").length, 1);
  });

  test("zero confirmations is refused off a fork and allowed on one", async () => {
    const node = (fork: boolean) => ({request: async () => (fork ? {} : Promise.reject(new Error("method not found")))}) as never;
    await assert.rejects(confirmationsFor(node(false), 0n), UnsafeConfirmations);
    await assert.rejects(confirmationsFor(node(false), undefined), UnsafeConfirmations);
    assert.equal(await confirmationsFor(node(false), 3n), 3n);
    assert.equal(await confirmationsFor(node(true), undefined), 0n);
    assert.equal(await confirmationsFor(node(true), 2n), 2n);
  });

  // Messages as the nodes sent them. The first is the one that stopped the
  // Railway indexer on 2 October 2026.
  test("a rate limit is not a range refusal, a range refusal still is", () => {
    const rateLimited = [
      "HTTP request failed.\n\nStatus: 429\nURL: https://rpc.mainnet.chain.robinhood.com\nDetails: Too Many Requests",
      "Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message.",
      "rate limit reached, slow down",
    ];
    const refused = [
      "ranges over 10000 blocks are not supported on free plan",
      "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.",
      "query exceeds max block range 100000",
      "query returned more than 10000 results, too many logs",
    ];
    for (const m of rateLimited) assert.equal(rangeRefused(m), false, m);
    for (const m of refused) assert.equal(rangeRefused(m), true, m);
  });

  // The page Cloudflare served the Railway indexer on 5 October 2026, cut short.
  test("a node that refuses every read is an outage, not a revert", async () => {
    const chain = new FakeChain();
    chain.emit(settledBatch(1n));
    const store = new MemoryStore();
    const c = chain.client();
    const ingest = new Ingest(c, store, DEPLOYMENT);
    await drain(ingest);
    const before = await ingest.checkpoint();

    const real = c.getBlock.bind(c);
    let down = true;
    c.getBlock = (async (args: Parameters<typeof real>[0]) => {
      if (down) throw new Error("HTTP request failed.\n\nStatus: 403\nURL: https://rpc.mainnet.chain.robinhood.com/\nDetails: \"<!DOCTYPE html><title>Just a moment...</title>\"");
      return real(args);
    }) as typeof c.getBlock;
    chain.emit(settledBatch(2n));
    for (let i = 0; i < 3; i += 1) await assert.rejects(ingest.step(), (e: Error) => /Status: 403/.test(e.message));
    assert.deepEqual(await ingest.checkpoint(), before);
    assert.equal(store.rows("batches").length, 1);

    down = false;
    const r = await ingest.step();
    assert.equal(r.rewoundTo, null);
    assert.equal(r.fullReset, false);
    assert.equal(store.rows("batches").length, 2);
  });

  test("a rate limited getLogs backs off and the next step indexes the same range", async () => {
    const chain = new FakeChain();
    chain.emit(settledBatch(7n));
    const store = new MemoryStore();
    const c = chain.client();
    const real = c.getLogs.bind(c);
    let calls = 0;
    // Four failures exhaust the step's own read retries, so the step throws.
    c.getLogs = (async (args: Parameters<typeof real>[0]) => {
      calls += 1;
      if (calls <= 4) throw new Error("HTTP request failed.\n\nStatus: 429\nDetails: Too Many Requests");
      return real(args);
    }) as typeof c.getLogs;
    const ingest = new Ingest(c, store, DEPLOYMENT);
    await assert.rejects(ingest.step(), (e: Error) => !(e instanceof RangeRefused) && /Too Many Requests/.test(e.message));
    const r = await ingest.step();
    assert.ok(r.logs > 0);
    assert.equal(store.rows("fills").length, 1);
  });
});
