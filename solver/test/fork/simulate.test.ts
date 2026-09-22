// F20, the dry run end to end, against the coordinator on :3000 and the fork
// under it. Each scenario runs once.
//
// Intents go in through POST /v1/intents with real signatures, the solver
// follows the batch through the stream, and at collect close it asks verify
// and submitSolution through eth_call. Nothing is sent.

import assert from "node:assert/strict";
import {before, describe, test} from "node:test";
import {erc20Abi, type Address, type PublicClient} from "viem";
import type {HDAccount} from "viem/accounts";
import type {BatchIntentsResponse, CurrentBatchResponse, NonceResponse} from "../../../packages/shared/api-types.ts";
import {STOCK_TOKENS, USDG} from "../../../packages/shared/addresses.ts";
import {oracleAbi} from "../../src/abi.ts";
import {quote} from "../../src/baseline.ts";
import {API, client, contracts, settlementAddress, type Contracts} from "../../src/chain.ts";
import {describeReport, once, type Report} from "../../src/index.ts";
import {PARTIAL_FILL, type Intent} from "../../src/solution.ts";
import {intentFor, sign, users} from "./lib.ts";

const QUOTE = USDG as Address;
const NVDA = STOCK_TOKENS.NVDA as Address;

let c: PublicClient;
let k: Contracts;
let who: HDAccount[];

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** A batch with at least minLeft seconds of collection ahead, so the intents land together. */
async function freshBatch(minLeft = 30): Promise<CurrentBatchResponse> {
  const deadline = performance.now() + 150_000;
  while (performance.now() < deadline) {
    const b = await get<CurrentBatchResponse>("/v1/batches/current");
    if (b.batchId !== null && b.collectEndsAt - b.chainTime >= minLeft) return b;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`no batch with ${minLeft} seconds left inside 150 seconds`);
}

async function submit(account: HDAccount, batch: CurrentBatchResponse, fields: Pick<Intent, "sellToken" | "buyToken" | "sellAmount" | "minBuyAmount" | "flags">): Promise<string> {
  const nonce = BigInt((await get<NonceResponse>(`/v1/nonces/${account.address}`)).next);
  const intent = intentFor(account.address, {
    ...fields,
    validAfter: batch.chainTime - 60,
    validUntil: batch.collectEndsAt + 3600,
    allowedSessions: 1 << batch.session,
    nonce,
  });
  const signature = await sign(c, k.settlement, account, intent);
  const payload = Object.fromEntries(Object.entries(intent).map(([key, v]) => [key, typeof v === "bigint" ? String(v) : v]));
  const res = await fetch(`${API}/v1/intents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({intent: payload, signature})});
  const body = (await res.json()) as {batchId?: string; code?: string; message?: string};
  if (!res.ok) throw new Error(`POST /v1/intents answered ${res.status} ${body.code}: ${body.message}`);
  assert.equal(body.batchId, batch.batchId, "a boundary fell between the submissions");
  return body.batchId!;
}

async function venue(tokenIn: Address, tokenOut: Address, amount: bigint): Promise<bigint> {
  const q = await quote(c, k.baselineAdapter, tokenIn, tokenOut, amount, await c.getBlockNumber());
  if (!q.ok) throw new Error(q.error);
  return q.out;
}

async function run(label: string, place: (batch: CurrentBatchResponse) => Promise<void>): Promise<Report> {
  const batch = await freshBatch();
  const solving = once({batchId: BigInt(batch.batchId!), log: (line) => console.log(`[${label}] ${line}`)});
  await place(batch);
  const report = await solving;
  console.log(`[${label}]\n${describeReport(report)}`);
  return report;
}

describe("F20 dry run against submitSolution", () => {
  before(async () => {
    c = client();
    k = await contracts(c, settlementAddress());
    who = users();
    await get("/v1/health");
    for (const [n, token] of [[0, QUOTE], [1, QUOTE], [1, NVDA]] as const) {
      const balance = await c.readContract({address: token, abi: erc20Abi, functionName: "balanceOf", args: [who[n]!.address]});
      console.log(`users[${n}] ${token} balance ${balance}`);
    }
  });

  test("routed, two intents on one side save nothing and pass", async () => {
    const report = await run("routed", async (batch) => {
      const legs: [HDAccount, bigint][] = [
        [who[0]!, 100n * 10n ** 6n],
        [who[1]!, 150n * 10n ** 6n],
      ];
      for (const [account, sell] of legs) {
        await submit(account, batch, {sellToken: QUOTE, buyToken: NVDA, sellAmount: sell, minBuyAmount: ((await venue(QUOTE, NVDA, sell)) * 99n) / 100n, flags: 0});
      }
    });
    assert.match(report.simulation, /would succeed/, report.simulation);
    assert.match(report.verify, /^ok/);
    assert.equal(report.savings, 0n);
    assert.equal(report.plan!.pairs[0]!.mode, "routed");
  });

  test("netted, opposite sides save something and touch no venue", async () => {
    const report = await run("netted", async (batch) => {
      const sell = 400n * 10n ** 6n;
      const askOut = await venue(QUOTE, NVDA, sell);
      const bidOut = await venue(NVDA, QUOTE, askOut);
      const buyNvda = (askOut * 2n * sell) / (sell + bidOut);
      await submit(who[0]!, batch, {sellToken: QUOTE, buyToken: NVDA, sellAmount: sell, minBuyAmount: buyNvda, flags: PARTIAL_FILL});
      await submit(who[1]!, batch, {sellToken: NVDA, buyToken: QUOTE, sellAmount: buyNvda, minBuyAmount: (await venue(NVDA, QUOTE, buyNvda)) + 1n, flags: PARTIAL_FILL});
    });
    assert.match(report.simulation, /would succeed/, report.simulation);
    assert.match(report.verify, /^ok/);
    assert.equal(report.savings > 0n, true);
    assert.equal(report.plan!.solution.venueCalls.length, 0);

    // The USDG row the feed serves, against what Settlement would read at the
    // same block. Measured, not corrected.
    const feed = await get<BatchIntentsResponse>(`/v1/batches/${report.batchId}/intents`);
    const row = feed.oraclePrices.find((r) => r.token.toLowerCase() === QUOTE.toLowerCase());
    const at = BigInt(feed.provenance.blockNumber);
    const [ref] = (await c.readContract({address: k.oracle, abi: oracleAbi(), functionName: "refPrice", args: [QUOTE], blockNumber: at})) as [bigint, bigint, boolean];
    const chainPrice = (ref * 10n ** 18n) / 10n ** 6n;
    console.log(`USDG row, feed ${row?.price ?? "absent"} refPrice ${row?.refPrice ?? "-"}, chain ${chainPrice} from refPrice ${ref} at block ${at}`);
  });
});
