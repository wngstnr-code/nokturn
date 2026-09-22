// F19 and F16 against the deployed verifier.
//
// Ten solutions, the two ForkDemo shapes and eight cleared from random signed
// intents, each checked through ClearingVerifier.verify at one block with the
// solver's own packing and the oracle prices Settlement would read. The savings
// have to match to the wei. Then volumeAt against evaluateVolume at two hundred
// prices, which needs no block at all because the verifier is pure.

import assert from "node:assert/strict";
import {before, describe, test} from "node:test";
import type {Address, PublicClient} from "viem";
import {STOCK_TOKENS, USDG} from "../../../packages/shared/addresses.ts";
import {isBatch, nextValidBatchId} from "../../../packages/shared/batch.ts";
import {createChainReader} from "../../../packages/shared/batch-viem.ts";
import {verifierAbi} from "../../src/abi.ts";
import {quote} from "../../src/baseline.ts";
import {client, contracts, settlementAddress, type Contracts} from "../../src/chain.ts";
import {legsOf, pairsOf, referencePairPrice, volumeAt} from "../../src/clearing.ts";
import {PARTIAL_FILL, packIntents, type Intent} from "../../src/solution.ts";
import {readInputs, solve, type SignedIntent} from "../../src/solve.ts";
import {verifyOnChain} from "../../src/simulate.ts";
import {rng} from "../unit/fixtures.ts";
import {intentFor, sign, users} from "./lib.ts";

const QUOTE = USDG as Address;
const NVDA = STOCK_TOKENS.NVDA as Address;
const AAPL = STOCK_TOKENS.AAPL as Address;
const SOLVER = "0x86d9065C8Bc1f0fa29d02cA873523C19C7859F95" as Address;

let c: PublicClient;
let k: Contracts;
let block: bigint;
let batchId: bigint;

async function venue(tokenIn: Address, tokenOut: Address, amount: bigint): Promise<bigint> {
  const q = await quote(c, k.baselineAdapter, tokenIn, tokenOut, amount, block);
  if (!q.ok) throw new Error(`venue cannot quote ${amount}: ${q.error}`);
  return q.out;
}

async function signAll(intents: Intent[]): Promise<SignedIntent[]> {
  const who = users();
  return Promise.all(
    intents.map(async (intent) => ({intent, signature: await sign(c, k.settlement, who.find((u) => u.address === intent.owner)!, intent)})),
  );
}

/** ForkDemo._buildRouted. Two buyers on one side, nothing to net. */
async function routedCase(): Promise<Intent[]> {
  const [a, b] = users();
  const legs: [Address, bigint][] = [
    [a!.address, 100n * 10n ** 6n],
    [b!.address, 150n * 10n ** 6n],
  ];
  return Promise.all(legs.map(async ([owner, sell], n) => intentFor(owner, {sellToken: QUOTE, buyToken: NVDA, sellAmount: sell, minBuyAmount: ((await venue(QUOTE, NVDA, sell)) * 99n) / 100n, nonce: BigInt(n)})));
}

/** ForkDemo._buildNetted. Half the round trip to each side. */
async function nettedCase(): Promise<Intent[]> {
  const [a, b] = users();
  const sell = 400n * 10n ** 6n;
  const askOut = await venue(QUOTE, NVDA, sell);
  const bidOut = await venue(NVDA, QUOTE, askOut);
  const buyNvda = (askOut * 2n * sell) / (sell + bidOut);
  return [
    intentFor(a!.address, {sellToken: QUOTE, buyToken: NVDA, sellAmount: sell, minBuyAmount: buyNvda, flags: PARTIAL_FILL, nonce: 10n}),
    intentFor(b!.address, {sellToken: NVDA, buyToken: QUOTE, sellAmount: buyNvda, minBuyAmount: (await venue(NVDA, QUOTE, buyNvda)) + 1n, flags: PARTIAL_FILL, nonce: 11n}),
  ];
}

/**
 * Buyers and sellers whose limits sit from ten basis points under what the
 * venue would give them to four over. With a five basis point pool each way
 * the greedy ones still cross and the modest ones can still route, so some
 * batches net and some route. The first two are one buyer and one seller of
 * NVDA, so every batch has two sides to try.
 */
async function randomCase(seed: number): Promise<Intent[]> {
  const r = rng(seed);
  const who = users();
  const out: Intent[] = [];
  const n = r.int(2, 8);
  for (let j = 0; j < n; j += 1) {
    const base = j < 2 || r.int(0, 3) !== 0 ? NVDA : AAPL;
    const owner = who[r.int(0, who.length - 1)]!.address;
    const greed = BigInt(10_000 + r.int(0, 14) - 10);
    const flags = r.bool() ? PARTIAL_FILL : 0;
    const nonce = BigInt(seed * 100 + j);
    if (j === 0 || (j > 1 && r.bool())) {
      const sell = r.big(50n, 500n) * 10n ** 6n;
      out.push(intentFor(owner, {sellToken: QUOTE, buyToken: base, sellAmount: sell, minBuyAmount: ((await venue(QUOTE, base, sell)) * greed) / 10_000n, flags, nonce}));
    } else {
      const sell = r.big(20n, 200n) * 10n ** 16n;
      out.push(intentFor(owner, {sellToken: base, buyToken: QUOTE, sellAmount: sell, minBuyAmount: ((await venue(base, QUOTE, sell)) * greed) / 10_000n, flags, nonce}));
    }
  }
  return out;
}

describe("F19 savings against the deployed verifier", () => {
  before(async () => {
    c = client();
    block = await c.getBlockNumber();
    k = await contracts(c, settlementAddress(), block);
    const now = (await c.getBlock({blockNumber: block})).timestamp;
    const lookup = await nextValidBatchId(createChainReader(c, k.sessions), now);
    if (!isBatch(lookup)) throw new Error(`no batch ahead of ${now}: ${lookup.reason}`);
    batchId = lookup.batchId;
  });

  test("ten solutions, savings equal to the wei", async () => {
    const cases: [string, Intent[]][] = [
      ["routed", await routedCase()],
      ["netted", await nettedCase()],
      ...(await Promise.all(Array.from({length: 8}, async (_, n) => [`random ${n + 1}`, await randomCase(104_729 * (n + 1))] as [string, Intent[]]))),
    ];
    let checked = 0;
    for (const [label, intents] of cases) {
      const signed = await signAll(intents);
      const tokens = [QUOTE, ...new Set(intents.flatMap((i) => [i.sellToken, i.buyToken]).filter((t) => t !== QUOTE))];
      const inputs = await readInputs(c, k, batchId, tokens, block);
      const plan = await solve(c, k, batchId, signed, QUOTE, SOLVER, inputs);
      const modes = plan.pairs.map((p) => `${p.mode}${p.reason ? ` (${p.reason})` : ""}`).join("; ");
      if (plan.solution.executions.length === 0) {
        console.log(`${label}: nothing executable, ${modes}`);
        continue;
      }
      const onChain = await verifyOnChain(c, k, plan.solution, inputs);
      console.log(`${label}: ${plan.solution.executions.length} executions, ${plan.solution.venueCalls.length} venue calls, solver ${plan.solution.claimedSavings}, verify ${onChain.ok ? onChain.savings : onChain.error}. ${modes}`);
      assert.equal(onChain.ok, true, `${label} ${onChain.ok ? "" : onChain.error}`);
      assert.equal(plan.solution.claimedSavings, onChain.ok ? onChain.savings : -1n, label);
      if (label === "routed") assert.equal(plan.solution.claimedSavings, 0n);
      if (label === "netted") {
        assert.equal(plan.solution.claimedSavings > 0n, true);
        assert.equal(plan.solution.venueCalls.length, 0);
      }
      checked += 1;
    }
    console.log(`block ${block}, batch ${batchId}, ${checked} of ${cases.length} solutions checked against verify`);
    assert.equal(checked >= 8, true, `only ${checked} solutions had anything to execute`);
  });

  test("F16 volumeAt equals evaluateVolume at 200 prices", async () => {
    const intents = [...(await randomCase(17)), ...(await nettedCase())].filter((i) => i.sellToken === NVDA || i.buyToken === NVDA);
    const pair = pairsOf(intents, QUOTE).pairs[0]!;
    const packed = packIntents(pair.entries.map((e) => e.intent), [QUOTE, NVDA]);
    const inputs = await readInputs(c, k, batchId, [QUOTE, NVDA], block);
    const q = inputs.oracle.get(QUOTE.toLowerCase()) as {price: bigint};
    const b = inputs.oracle.get(NVDA.toLowerCase()) as {price: bigint};
    const center = referencePairPrice({quotePrice: q.price, basePrice: b.price, maxDeviationBps: 0n});
    const r = rng(2026);
    let nonZero = 0;
    for (let n = 0; n < 200; n += 1) {
      const price = (center * BigInt(9_970 + r.int(0, 60))) / 10_000n + BigInt(r.int(0, 999));
      const [demand, supply, executable] = (await c.readContract({address: k.verifier, abi: verifierAbi(), functionName: "evaluateVolume", args: [packed, price]})) as [bigint, bigint, bigint];
      const mine = volumeAt(legsOf(pair), price);
      assert.deepEqual([mine.demand, mine.supply, mine.executable], [demand, supply, executable], `price ${price}`);
      if (executable > 0n) nonZero += 1;
    }
    console.log(`${pair.entries.length} intents, 200 prices around ${center}, ${nonZero} with volume`);
    assert.equal(nonZero > 0, true);
  });
});
