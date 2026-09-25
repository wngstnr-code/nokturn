import assert from "node:assert/strict";
import {describe, test} from "node:test";
import type {Address} from "viem";
import {computeMetrics} from "../../src/metrics.ts";
import {attribute, buildReceipt, type BatchFacts, type ReceiptContext} from "../../src/receipt.ts";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const A = "0xc3e87ba4132708838243a717c4b90112271ceee3";
const B = "0x14e9ef9fd45e6b1e8dbc229ddc3212db1d21a0ab";
const ADAPTER = "0x69d3f8d1e0c0a75bbe93dca9097ef034b2ef2e0b";
const POOL = "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3";

const prov = (block: number, log: number) => ({chain_id: 4663, block_number: String(block), block_timestamp: String(1_789_893_700 + block), tx_hash: `0x${String(block).padStart(64, "0")}`, log_index: log});

function ctx(quotes: Record<string, bigint | null> = {}): ReceiptContext {
  return {
    chainId: 4663,
    source: {kind: "fork", forkedFrom: 4663, pinnedBlock: "67798044", pinnedAt: 1_789_893_000},
    tokens: new Map([
      [USDG, {symbol: "USDG", decimals: 6}],
      [NVDA, {symbol: "NVDA", decimals: 18, pool: POOL}],
    ]),
    quoteToken: USDG,
    explorer: "https://robinhoodchain.blockscout.com",
    rpcUrl: "http://127.0.0.1:8545",
    baselineAdapter: ADAPTER as Address,
    session: 6 as never,
    sessionName: "WEEKEND" as never,
    batchDurationSeconds: 60,
    maxDeviationBps: 300,
    quote: async (sell, _buy, amount) => (`${sell}:${amount}` in quotes ? quotes[`${sell}:${amount}`]! : null),
  };
}

/** users[0] sells 400 USDG, users[1] sells 1 NVDA, and 150 USDG of the first reaches the venue. */
function nettedFacts(): BatchFacts {
  return {
    batch: {batch_id: "1789893780", outcome: "settled", reason: null, session: 6, intent_count: 2, netted_usd: "250", routed_usd: "150", savings_usd: "9", solver_fee_usd: "0", protocol_fee_usd: "0", solver: "0xsolver", ...prov(20, 9)},
    fills: [
      {owner: A, intent_hash: "0xaa", sell_token: USDG, buy_token: NVDA, executed_sell: "400", executed_buy: "210", baseline_buy: "200", savings_usd: "5", ...prov(20, 5)},
      {owner: B, intent_hash: "0xbb", sell_token: NVDA, buy_token: USDG, executed_sell: "100", executed_buy: "260", baseline_buy: "250", savings_usd: "4", ...prov(20, 6)},
    ],
    prices: [{token: NVDA, price: "1010", ref_price: "1000", deviation_bps: "100", ...prov(20, 3)}],
    solutions: [{solver: "0xsolver", solution_hash: "0xhash", claimed_savings: "9", accepted: true, rejection_reason: null, ...prov(12, 0)}],
    venueRoutes: [{adapter: ADAPTER, token_in: USDG, token_out: NVDA, amount_in: "150", amount_out: "78", ...prov(20, 2)}],
    collectionFailures: [],
    winning: {
      solution_hash: "0xhash",
      solution: {
        intents: [
          {owner: A, receiver: A, sellToken: USDG, buyToken: NVDA, sellAmount: "400"},
          {owner: B, receiver: B, sellToken: NVDA, buyToken: USDG, sellAmount: "150"},
        ],
        executions: [
          {intentIndex: "0", executedSell: "400", executedBuy: "210"},
          {intentIndex: "1", executedSell: "100", executedBuy: "260"},
        ],
        venueCalls: [{adapter: ADAPTER, tokenIn: USDG, tokenOut: NVDA, amountIn: "150", minOut: "77"}],
      },
      ...prov(20, 9),
    },
  };
}

describe("receipt", () => {
  test("a settled batch reads every figure from the facts and the chain", async () => {
    const built = await buildReceipt(1_789_893_780n, nettedFacts(), ctx({[`${USDG}:400`]: 200n, [`${NVDA}:100`]: 251n}));
    const r = built!.receipt;
    assert.equal(r.outcome, "settled");
    assert.equal(r.failure, null);
    assert.equal(r.totals.notionalUsd, "400");
    assert.equal(r.totals.nettingRatioBps, "6250");
    assert.equal(r.participantCount, 2);
    const [a, b] = r.fills;
    assert.equal(a!.improvementBps, "500");
    assert.equal(a!.partial, false);
    assert.equal(b!.partial, true);
    assert.deepEqual(a!.attribution, {nettedSell: "250", routedSell: "150"});
    assert.deepEqual(b!.attribution, {nettedSell: "100", routedSell: "0"});
    assert.equal(a!.verifyBaseline.blockNumber, "11");
    assert.match(a!.verifyBaseline.castCommand, /quoteFromState\(address,address,uint256\)\(uint256\)" 0x5fc5.* 400 --block 11 --rpc-url http/);
    assert.equal(a!.provenance.transactionHash, prov(20, 5).tx_hash);
    assert.equal(r.venueRoutes[0]!.minOut, "77");
    assert.equal(r.venueRoutes[0]!.pool, POOL);
    assert.equal(r.clearingPrices[0]!.withinBand, true);
    // The second fill's recomputed baseline disagrees with its event, and says so.
    assert.deepEqual(built!.baselineMismatches, [{intentHash: "0xbb", baselineBuy: "250", expected: "251"}]);
    assert.equal(b!.verifyBaseline.expected, "251");
  });

  test("a passthrough names the owner that could not be collected, and carries no invented figures", async () => {
    const f = nettedFacts();
    f.batch = {...f.batch!, outcome: "passthrough", reason: "intent could not be collected", netted_usd: null, routed_usd: null, savings_usd: null, solver: null};
    f.fills = [];
    f.venueRoutes = [];
    f.prices = [];
    f.collectionFailures = [{owner: B, intent_index: 1, ...prov(20, 1)}];
    const r = (await buildReceipt(1n, f, ctx()))!.receipt;
    assert.equal(r.outcome, "passthrough");
    assert.equal(r.failure!.code, "IntentCollectionFailed");
    assert.match(r.failure!.reason, new RegExp(`owner ${B} could not be collected at intent 1`));
    assert.equal(r.failure!.baselineBuy, null);
    assert.equal(r.failure!.shortfall, null);
    assert.equal(r.failure!.feeCharged, "0");
    assert.equal(r.participantCount, 2);
    assert.equal(r.totals.nettingRatioBps, "0");
    assert.equal(r.solver, "0xsolver");
  });

  test("an expired batch maps to WinnerNeverFinalized", async () => {
    const f = nettedFacts();
    f.batch = {...f.batch!, outcome: "expired", reason: "winner never finalized", intent_count: 0, netted_usd: null, routed_usd: null, solver: null};
    f.fills = [];
    f.winning = null;
    const r = (await buildReceipt(2n, f, ctx()))!.receipt;
    assert.equal(r.outcome, "expired");
    assert.equal(r.failure!.code, "WinnerNeverFinalized");
  });

  test("an unknown batch has no receipt", async () => {
    assert.equal(await buildReceipt(3n, {...nettedFacts(), batch: null}, ctx()), null);
  });

  test("netted plus routed is executedSell for every fill, whatever the split", () => {
    const fills = [
      {sellToken: USDG, buyToken: NVDA, executedSell: 333n},
      {sellToken: USDG, buyToken: NVDA, executedSell: 667n},
      {sellToken: NVDA, buyToken: USDG, executedSell: 5n},
    ];
    const out = attribute(fills, [{tokenIn: USDG, tokenOut: NVDA, amountIn: 101n}]);
    out.forEach((a, i) => assert.equal(a.nettedSell + a.routedSell, fills[i]!.executedSell));
    assert.deepEqual(out.map((a) => a.routedSell), [33n, 67n, 0n]);
  });
});

describe("metrics", () => {
  test("the four formulas on a case worked by hand", () => {
    // Two settled batches. Notional 400 + 100 = 500, netted 250 + 50 = 300.
    // Savings 9 + 1 = 10, so savings_bps = 10 / 500 = 200 bps.
    // improvement = (10 + 10 + 1) / (200 + 250 + 99) = 21 / 549 = 382 bps floored.
    // Three batches had a winner and two settled, uptime 6666 bps.
    const m = computeMetrics({
      fills: [
        {executedBuy: 210n, baselineBuy: 200n, savingsUsd: 5n},
        {executedBuy: 260n, baselineBuy: 250n, savingsUsd: 4n},
        {executedBuy: 100n, baselineBuy: 99n, savingsUsd: 1n},
      ],
      batches: [
        {outcome: "settled", nettedUsd: 250n, routedUsd: 150n},
        {outcome: "settled", nettedUsd: 50n, routedUsd: 50n},
        {outcome: "expired", nettedUsd: 0n, routedUsd: 0n},
      ],
      batchesWithWinner: 3,
    });
    assert.equal(m.savingsBps, "200");
    assert.equal(m.nettingRatioBps, "6000");
    assert.equal(m.improvementVsVenueBps, "382");
    assert.equal(m.uptimeBps, "6666");
  });
});
