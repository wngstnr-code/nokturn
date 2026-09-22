// Signed flow for the solver run, the F21 one hour criterion.
//
// Local signers on a fork of mainnet 4663. The pools, tokens and prices are
// real, the intents are not real flow, and the output says so first.
//
//   node infra/scripts/flow.mjs --duration <minutes>
//
// Every batch the stream opens gets two to four intents from the demo users,
// with direction and token rotating so the run sees netted and routed batches
// both. Sizes are read against the exposure caps on chain at start, and the
// whole budget is printed before anything is signed.

import {readFileSync} from "node:fs";
import {formatUnits} from "viem";
import {mnemonicToAccount} from "viem/accounts";
import {chain, settlementAbi} from "../../api/src/chain.ts";
import {quote} from "../../solver/src/baseline.ts";
import {buildSignedIntent} from "./sign-intent.mjs";

const API = process.env.NOKTURN_API_URL ?? "http://127.0.0.1:3000";
const here = new URL(".", import.meta.url);
const accounts = JSON.parse(readFileSync(new URL("../accounts.json", here), "utf8"));
const MNEMONIC = process.env.NOKTURN_FORK_MNEMONIC ?? accounts._mnemonic;

const at = process.argv.indexOf("--duration");
const minutes = at >= 0 ? Number(process.argv[at + 1]) : NaN;
if (!(minutes > 0)) {
  console.error("usage: node infra/scripts/flow.mjs --duration <minutes>");
  process.exit(2);
}

const users = accounts.users.map((expected, i) => {
  const a = mnemonicToAccount(MNEMONIC, {addressIndex: 6 + i});
  if (a.address.toLowerCase() !== expected.toLowerCase()) throw new Error(`index ${6 + i} is not users[${i}]`);
  return a;
});

const c = chain();
const USDG = c.quote.address;
// Allowlist v1.0, parameter.md section 10.1.
const TOKENS = ["NVDA", "AAPL", "TSLA", "GOOGL"].map((symbol) => c.tokens.find((t) => t.symbol === symbol));

const read = (functionName) => c.client.readContract({address: c.deployment.settlement, abi: settlementAbi, functionName});
const [perBatch, perTokenDaily, globalDaily] = await Promise.all([read("capPerBatchUsd"), read("capPerTokenDailyUsd"), read("capGlobalDailyUsd")]);

// Weekend and protective sessions halve every cap, and USDG sits in every batch,
// so its per token cap binds first. Budget a quarter of the tighter daily cap,
// and count every intent twice because a netted batch charges both legs.
const WAD = 10n ** 18n;
const tighter = perTokenDaily < globalDaily ? perTokenDaily : globalDaily;
const budgetUsd = tighter / 4n;
const expectedIntents = BigInt(Math.ceil(minutes)) * 4n;
let sizeUsd = budgetUsd / (expectedIntents * 2n);
const perBatchRoom = perBatch / 4n / 4n;
if (sizeUsd > perBatchRoom) sizeUsd = perBatchRoom;
const MAX_SIZE_USD = 50n * WAD;
if (sizeUsd > MAX_SIZE_USD) sizeUsd = MAX_SIZE_USD;
const sizeUsdg = (sizeUsd * 10n ** 6n) / WAD;

console.log("local signers on a fork of mainnet 4663, real pools and prices, not real flow");
console.log(`caps on chain, USD 1e18: per batch ${perBatch}, per token daily ${perTokenDaily}, global daily ${globalDaily}`);
console.log(`budget ${formatUnits(budgetUsd, 18)} USD over at most ${expectedIntents} intents, ${formatUnits(sizeUsdg, 6)} USDG each, for ${minutes} chain minutes`);

async function venue(tokenIn, tokenOut, amount) {
  const q = await quote(c.client, c.deployment.adapter, tokenIn, tokenOut, amount, await c.client.getBlockNumber());
  if (!q.ok) throw new Error(`quoteFromState reverts ${q.error}`);
  return q.out;
}

const counts = {};
const tally = (key) => (counts[key] = (counts[key] ?? 0) + 1);

async function send(account, sellToken, buyToken, sellAmount, minBuyAmount, flags) {
  try {
    const built = await buildSignedIntent({account, sellAmount, fields: {sellToken, buyToken, sellAmount: String(sellAmount), minBuyAmount: String(minBuyAmount), flags: String(flags)}});
    const res = await fetch(`${API}/v1/intents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({intent: built.intent, signature: built.signature})});
    const body = await res.json();
    tally(res.ok ? `${res.status}` : `${res.status} ${body.code}`);
  } catch (error) {
    tally(`not sent, ${error.message.split("\n")[0].slice(0, 80)}`);
  }
}

/** Three shapes in rotation. Opposite sides that can net, two buys, two sells. */
async function fill(n) {
  const token = TOKENS[n % TOKENS.length].token;
  const shape = n % 3;
  const [a, b, x, y] = [users[n % 4], users[(n + 1) % 4], users[(n + 2) % 4], users[(n + 3) % 4]];
  const tokensFor = await venue(USDG, token, sizeUsdg);
  if (shape === 0) {
    await send(a, USDG, token, sizeUsdg, (tokensFor * 99n) / 100n, 1);
    await send(b, token, USDG, tokensFor, ((await venue(token, USDG, tokensFor)) * 99n) / 100n, 1);
    const small = sizeUsdg / 2n;
    await send(x, USDG, token, small, ((await venue(USDG, token, small)) * 99n) / 100n, 1);
    return 3;
  }
  if (shape === 1) {
    await send(a, USDG, token, sizeUsdg, (tokensFor * 99n) / 100n, 0);
    await send(b, USDG, token, sizeUsdg / 2n, ((await venue(USDG, token, sizeUsdg / 2n)) * 99n) / 100n, 0);
    return 2;
  }
  const half = tokensFor / 2n;
  for (const u of [a, b, x, y]) await send(u, token, USDG, half, ((await venue(token, USDG, half)) * 99n) / 100n, 0);
  return 4;
}

const start = (await c.client.getBlock()).timestamp;
const endAt = start + BigInt(Math.round(minutes * 60));
let batches = 0;
let intents = 0;
const seen = new Set();
const busy = new Set();

const ws = new WebSocket(`${API.replace(/^http/, "ws")}/v1/stream`);
ws.addEventListener("open", () => ws.send(JSON.stringify({type: "subscribe", topics: ["batch.opened"]})));
ws.addEventListener("message", (e) => {
  const f = JSON.parse(String(e.data));
  if (f.type !== "batch.opened" || f.data.batchId === null || seen.has(f.data.batchId)) return;
  if (BigInt(f.data.chainTime) >= endAt) return;
  // The snapshot on subscribe can name a batch about to close.
  if (f.data.collectEndsAt - f.data.chainTime < 15) return;
  seen.add(f.data.batchId);
  const n = batches++;
  const task = fill(n)
    .then((k) => (intents += k))
    .catch((error) => tally(`batch failed, ${error.message.split("\n")[0].slice(0, 80)}`))
    .finally(() => busy.delete(task));
  busy.add(task);
});

await new Promise((resolve, reject) => {
  const unwatch = c.client.watchBlocks({
    pollingInterval: 1_000,
    onBlock: (b) => {
      if (b.timestamp >= endAt) {
        unwatch();
        resolve();
      }
    },
    onError: (error) => {
      unwatch();
      reject(error);
    },
  });
});
ws.close();
await Promise.all(busy);

console.log(`done at chain time ${endAt}. ${batches} batches, ${intents} intents attempted, local signers, not real flow`);
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(40)} ${v}`);
