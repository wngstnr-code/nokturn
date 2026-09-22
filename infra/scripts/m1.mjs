// M1, backend side. One batch from a signature through the API to a finalize
// transaction on the fork, proven from the chain rather than from the solver's
// own log. Then the same for two intents on one side, the routed case.
//
// Local signers on a fork of mainnet 4663. Real pools, real tokens, real prices,
// named block. Not mainnet, and not real flow.
//
//   node infra/scripts/m1.mjs

import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {erc20Abi, parseEventLogs, parseUnits} from "viem";
import {mnemonicToAccount} from "viem/accounts";
import {chain, settlementAbi} from "../../api/src/chain.ts";
import {quote} from "../../solver/src/baseline.ts";
import {buildSignedIntent} from "./sign-intent.mjs";

const API = process.env.NOKTURN_API_URL ?? "http://127.0.0.1:3000";
const here = new URL(".", import.meta.url);
const accounts = JSON.parse(readFileSync(new URL("../accounts.json", here), "utf8"));
const pin = JSON.parse(readFileSync(new URL("../pinned-block.json", here), "utf8"));
const MNEMONIC = process.env.NOKTURN_FORK_MNEMONIC ?? accounts._mnemonic;
/** sign-intent.mjs derives users[i] at 6 + i and checks it against accounts.json. */
const users = [0, 1].map((i) => {
  const a = mnemonicToAccount(MNEMONIC, {addressIndex: 6 + i});
  if (a.address.toLowerCase() !== accounts.users[i].toLowerCase()) throw new Error(`index ${6 + i} is not users[${i}]`);
  return a;
});

/** Chain minutes. Two batches at the sixty second weekend cadence, with room for both finalizes. */
const SOLVER_MINUTES = "4";

const c = chain();
const settlement = c.deployment.settlement;
const USDG = c.quote.address;
const NVDA = c.tokens.find((t) => t.symbol === "NVDA").token;

const get = async (path) => {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}: ${await res.text()}`);
  return res.json();
};

async function venue(tokenIn, tokenOut, amount) {
  const q = await quote(c.client, c.deployment.adapter, tokenIn, tokenOut, amount, await c.client.getBlockNumber());
  if (!q.ok) throw new Error(`quoteFromState ${tokenIn} to ${tokenOut} reverts ${q.error}`);
  return q.out;
}

/** Waits on blocks, not on the laptop clock, for a batch with at least minLeft seconds of collection. */
async function freshBatch(minLeft, after) {
  return new Promise((resolve, reject) => {
    const unwatch = c.client.watchBlocks({
      emitOnBegin: true,
      pollingInterval: 500,
      onBlock: async () => {
        try {
          const b = await get("/v1/batches/current");
          if (b.batchId !== null && BigInt(b.batchId) > after && b.collectEndsAt - b.chainTime >= minLeft) {
            unwatch();
            resolve(b);
          }
        } catch (error) {
          unwatch();
          reject(error);
        }
      },
    });
  });
}

async function post(built) {
  const res = await fetch(`${API}/v1/intents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({intent: built.intent, signature: built.signature})});
  const body = await res.json();
  if (!res.ok) throw new Error(`POST /v1/intents answered ${res.status} ${body.code}: ${body.message}`);
  return body.batchId;
}

async function place(label, legs, after = 0n) {
  const batch = await freshBatch(25, after);
  const placed = [];
  for (const leg of legs) {
    const built = await buildSignedIntent({
      account: leg.account,
      sellAmount: leg.sellAmount,
      fields: {sellToken: leg.sellToken, buyToken: leg.buyToken, sellAmount: String(leg.sellAmount), minBuyAmount: String(leg.minBuyAmount), flags: String(leg.flags)},
    });
    const batchId = await post(built);
    if (batchId !== batch.batchId) throw new Error(`${label}: a batch boundary fell between the submissions, ${batchId} vs ${batch.batchId}`);
    placed.push({owner: leg.account.address, nonce: BigInt(built.intent.nonce), sellToken: leg.sellToken, buyToken: leg.buyToken});
  }
  console.log(`${label}: ${legs.length} intents signed and accepted into batch ${batch.batchId}`);
  return {batchId: BigInt(batch.batchId), placed};
}

const balanceAt = (token, owner, blockNumber) => c.client.readContract({address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber});
const nonceUsedAt = (owner, nonce, blockNumber) => c.client.readContract({address: settlement, abi: settlementAbi, functionName: "nonceUsed", args: [owner, nonce], blockNumber});

/** Everything Settlement emitted about one batch, from the chain. */
async function prove(label, {batchId, placed}, fromBlock) {
  const logs = parseEventLogs({abi: settlementAbi, logs: await c.client.getLogs({address: settlement, fromBlock, toBlock: "latest"})});
  const mine = logs.filter((l) => l.args.batchId === batchId);
  const names = mine.map((l) => l.eventName);
  // A routed batch that saves nothing emits BatchPassthrough "savings below
  // threshold" and then BatchSettled, in the same finalize, with every intent
  // executed. Measured 23 September 2026. BatchSettled decides.
  const closing = mine.find((l) => l.eventName === "BatchSettled") ?? mine.find((l) => l.eventName === "BatchPassthrough");
  const out = {label, batchId: String(batchId), events: names, finalizeTx: closing?.transactionHash ?? null, block: closing ? String(closing.blockNumber) : null};
  if (!closing) return {...out, verdict: "no BatchSettled or BatchPassthrough for this batch on chain"};
  const passthrough = mine.find((l) => l.eventName === "BatchPassthrough");
  if (passthrough) out.passthroughReason = passthrough.args.reason;

  const at = closing.blockNumber;
  const settled = mine.filter((l) => l.eventName === "IntentSettled");
  out.intents = [];
  let exact = true;
  for (const p of placed) {
    const ev = settled.find((l) => l.args.owner.toLowerCase() === p.owner.toLowerCase());
    const [sellBefore, sellAfter, buyBefore, buyAfter, usedBefore, usedAfter] = await Promise.all([
      balanceAt(p.sellToken, p.owner, at - 1n),
      balanceAt(p.sellToken, p.owner, at),
      balanceAt(p.buyToken, p.owner, at - 1n),
      balanceAt(p.buyToken, p.owner, at),
      nonceUsedAt(p.owner, p.nonce, at - 1n),
      nonceUsedAt(p.owner, p.nonce, at),
    ]);
    const row = {
      owner: p.owner,
      nonce: String(p.nonce),
      sold: String(sellBefore - sellAfter),
      bought: String(buyAfter - buyBefore),
      executedSell: ev ? String(ev.args.executedSell) : null,
      executedBuy: ev ? String(ev.args.executedBuy) : null,
      baselineBuy: ev ? String(ev.args.baselineBuy) : null,
      nonceUsed: `${usedBefore} -> ${usedAfter}`,
    };
    if (!ev || row.sold !== row.executedSell || row.bought !== row.executedBuy || usedBefore || !usedAfter) exact = false;
    out.intents.push(row);
  }
  const header = await c.client.getBlock({blockNumber: at});
  out.blockTimestamp = String(header.timestamp);
  out.verdict = closing.eventName === "BatchSettled" && settled.length === placed.length && exact
    ? "settled, every balance moved by exactly executedSell and executedBuy, every nonce spent in this block"
    : "see events and intents";
  return out;
}

const startBlock = await c.client.getBlockNumber();
console.log(`fork of mainnet 4663 pinned at block ${pin.block}, local signers, head ${startBlock}. not mainnet`);

const solver = spawn(process.execPath, ["solver/src/index.ts", "--run", "--duration", SOLVER_MINUTES], {cwd: new URL("../../", here), stdio: ["ignore", "pipe", "pipe"]});
const solverDone = new Promise((resolve) => solver.on("exit", resolve));
const prefixed = (d) => String(d).replace(/\n$/, "").replace(/^/gm, "[solver] ") + "\n";
solver.stdout.on("data", (d) => process.stdout.write(prefixed(d)));
solver.stderr.on("data", (d) => process.stderr.write(prefixed(d)));

const sell = parseUnits("400", 6);
const askOut = await venue(USDG, NVDA, sell);
const bidOut = await venue(NVDA, USDG, askOut);
const buyNvda = (askOut * 2n * sell) / (sell + bidOut);
const netted = await place("netted", [
  {account: users[0], sellToken: USDG, buyToken: NVDA, sellAmount: sell, minBuyAmount: buyNvda, flags: 1},
  {account: users[1], sellToken: NVDA, buyToken: USDG, sellAmount: buyNvda, minBuyAmount: (await venue(NVDA, USDG, buyNvda)) + 1n, flags: 1},
]);

const routedLegs = [];
for (const [account, amount] of [[users[0], parseUnits("100", 6)], [users[1], parseUnits("150", 6)]]) {
  routedLegs.push({account, sellToken: USDG, buyToken: NVDA, sellAmount: amount, minBuyAmount: ((await venue(USDG, NVDA, amount)) * 99n) / 100n, flags: 0});
}
const routed = await place("routed", routedLegs, netted.batchId);

const code = await solverDone;
console.log(`solver exited with ${code}`);

const result = {
  note: "fork of mainnet 4663, local signers, not mainnet and not real flow",
  pinnedBlock: pin.block,
  settlement,
  netted: await prove("netted", netted, startBlock),
  routed: await prove("routed", routed, startBlock),
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.netted.verdict.startsWith("settled") ? 0 : 1);
