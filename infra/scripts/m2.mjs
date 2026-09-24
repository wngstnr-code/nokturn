// M2. One receipt with netting and a baseline gap, proven from the chain.
//
// A pair is netted or routed as a whole, never a mix, so the receipt needs two
// pairs in the same batch to show both: opposite NVDA intents that net in full,
// and a one sided AAPL intent that has nowhere to net and reaches the venue. The
// solver settles it, the indexer records it, and GET /v1/batches/:batchId is
// checked against the chain field by field, including running every
// verifyBaseline command with cast.
//
// Local signers on a fork of mainnet 4663. Not mainnet and not real flow.
//
//   node infra/scripts/m2.mjs

import {execFileSync, spawn} from "node:child_process";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {erc20Abi, parseEventLogs, parseUnits} from "viem";
import {mnemonicToAccount} from "viem/accounts";
import {chain, settlementAbi} from "../../api/src/chain.ts";
import {quote} from "../../solver/src/baseline.ts";
import {buildSignedIntent} from "./sign-intent.mjs";

const API = process.env.NOKTURN_API_URL ?? "http://127.0.0.1:3000";
const here = new URL(".", import.meta.url);
const root = new URL("../../", here);
const accounts = JSON.parse(readFileSync(new URL("../accounts.json", here), "utf8"));
const pin = JSON.parse(readFileSync(new URL("../pinned-block.json", here), "utf8"));
const MNEMONIC = process.env.NOKTURN_FORK_MNEMONIC ?? accounts._mnemonic;
const users = [0, 1, 2].map((i) => {
  const a = mnemonicToAccount(MNEMONIC, {addressIndex: 6 + i});
  if (a.address.toLowerCase() !== accounts.users[i].toLowerCase()) throw new Error(`index ${6 + i} is not users[${i}]`);
  return a;
});

/** Chain minutes. One sixty second batch, its finalize, and room to index it. */
const RUN_MINUTES = "3";

const c = chain();
const settlement = c.deployment.settlement;
const USDG = c.quote.address;
const NVDA = c.tokens.find((t) => t.symbol === "NVDA").token;
const AAPL = c.tokens.find((t) => t.symbol === "AAPL").token;

const get = async (path) => {
  const res = await fetch(`${API}${path}`);
  const body = await res.json();
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}: ${JSON.stringify(body)}`);
  return body;
};

async function venue(tokenIn, tokenOut, amount) {
  const q = await quote(c.client, c.deployment.adapter, tokenIn, tokenOut, amount, await c.client.getBlockNumber());
  if (!q.ok) throw new Error(`quoteFromState reverts ${q.error}`);
  return q.out;
}

function freshBatch(minLeft) {
  return new Promise((resolve, reject) => {
    const unwatch = c.client.watchBlocks({
      emitOnBegin: true,
      pollingInterval: 500,
      onBlock: async () => {
        try {
          const b = await get("/v1/batches/current");
          if (b.batchId !== null && b.collectEndsAt - b.chainTime >= minLeft) {
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

function child(label, args) {
  const p = spawn(process.execPath, args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]});
  const prefix = (d) => String(d).replace(/\n$/, "").replace(/^/gm, `[${label}] `) + "\n";
  p.stdout.on("data", (d) => process.stdout.write(prefix(d)));
  p.stderr.on("data", (d) => process.stderr.write(prefix(d)));
  return new Promise((resolve) => p.on("exit", resolve));
}

const startBlock = await c.client.getBlockNumber();
console.log(`fork of mainnet 4663 pinned at block ${pin.block}, local signers, head ${startBlock}. not mainnet`);

const solverDone = child("solver", ["solver/src/index.ts", "--run", "--duration", RUN_MINUTES]);
const indexerDone = child("indexer", ["indexer/src/index.ts", "--duration", RUN_MINUTES]);

// users[0] and users[1] cross on NVDA, both PARTIAL_FILL, so solve.ts nets that
// pair in full (one pair is netted or routed, never a mix). users[2] sells AAPL
// alone, with no counterparty, so that pair has nowhere to net and goes to the
// venue. One batch, one pair netted, one pair routed, the mix the receipt needs
// to show both nettingRatioBps between 0 and 100 percent and a real baseline gap.
const batch = await freshBatch(25);
const nvdaSell = parseUnits("400", 6);
const nvdaOther = await venue(USDG, NVDA, parseUnits("150", 6));
const aaplSell = parseUnits("80", 6);
const legs = [
  {account: users[0], sellToken: USDG, buyToken: NVDA, sellAmount: nvdaSell, minBuyAmount: ((await venue(USDG, NVDA, nvdaSell)) * 99n) / 100n},
  {account: users[1], sellToken: NVDA, buyToken: USDG, sellAmount: nvdaOther, minBuyAmount: ((await venue(NVDA, USDG, nvdaOther)) * 99n) / 100n},
  {account: users[2], sellToken: USDG, buyToken: AAPL, sellAmount: aaplSell, minBuyAmount: ((await venue(USDG, AAPL, aaplSell)) * 99n) / 100n, flags: "0"},
];
for (const leg of legs) {
  const built = await buildSignedIntent({account: leg.account, sellAmount: leg.sellAmount, fields: {sellToken: leg.sellToken, buyToken: leg.buyToken, sellAmount: String(leg.sellAmount), minBuyAmount: String(leg.minBuyAmount), flags: leg.flags ?? "1"}});
  const res = await fetch(`${API}/v1/intents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({intent: built.intent, signature: built.signature})});
  const body = await res.json();
  if (!res.ok || body.batchId !== batch.batchId) throw new Error(`POST /v1/intents answered ${res.status} ${JSON.stringify(body)}`);
}
const batchId = BigInt(batch.batchId);
console.log(`three intents across two pairs accepted into batch ${batchId}`);

console.log(`solver exited ${await solverDone}, indexer exited ${await indexerDone}`);

const receipt = await get(`/v1/batches/${batchId}`);
mkdirSync(new URL("../.torture/", here), {recursive: true});
writeFileSync(new URL("../.torture/m2-receipt.json", here), JSON.stringify(receipt, null, 2));

const checks = [];
const check = (name, ok, detail) => checks.push({name, ok: Boolean(ok), detail});

const logs = parseEventLogs({abi: settlementAbi, logs: await c.client.getLogs({address: settlement, fromBlock: startBlock, toBlock: "latest"})}).filter((l) => l.args.batchId === batchId);
const settled = logs.find((l) => l.eventName === "BatchSettled");
check("outcome settled", receipt.outcome === "settled" && settled, receipt.outcome);
const ratio = BigInt(receipt.totals.nettingRatioBps);
check("netting strictly between 0 and 100 percent", ratio > 0n && ratio < 10_000n, `${ratio} bps`);
if (settled) {
  const a = settled.args;
  check(
    "totals equal BatchSettled",
    receipt.totals.nettedVolumeUsd === String(a.nettedVolumeUsd) && receipt.totals.routedVolumeUsd === String(a.routedVolumeUsd) && receipt.totals.totalSavingsUsd === String(a.totalSavingsUsd) && receipt.totals.solverFeeUsd === String(a.solverFeeUsd) && receipt.totals.protocolFeeUsd === String(a.protocolFeeUsd),
    {netted: String(a.nettedVolumeUsd), routed: String(a.routedVolumeUsd), savings: String(a.totalSavingsUsd)},
  );
  check("receipt provenance is the BatchSettled log", receipt.provenance.transactionHash === settled.transactionHash.toLowerCase() && receipt.provenance.logIndex === settled.logIndex, `${settled.transactionHash}:${settled.logIndex}`);
}

const intentLogs = logs.filter((l) => l.eventName === "IntentSettled");
const casts = [];
for (const f of receipt.fills) {
  check(`fill ${f.intentHash} carries baseline, savings and improvement`, f.baselineBuy && f.savingsUsd && f.improvementBps !== undefined, `${f.baselineBuy} ${f.savingsUsd} ${f.improvementBps}`);
  const ev = intentLogs.find((l) => l.args.intentHash.toLowerCase() === f.intentHash.toLowerCase());
  check(`fill ${f.intentHash} provenance is its IntentSettled log`, ev && f.provenance.transactionHash === ev.transactionHash.toLowerCase() && f.provenance.logIndex === ev.logIndex && f.executedBuy === String(ev.args.executedBuy), ev ? `${ev.transactionHash}:${ev.logIndex}` : "no event");
  const cmd = f.verifyBaseline.castCommand;
  const args = cmd.match(/"[^"]*"|\S+/g).slice(1).map((s) => s.replace(/^"|"$/g, ""));
  const out = execFileSync("cast", args, {encoding: "utf8"}).trim().split(/\s+/)[0];
  casts.push({intentHash: f.intentHash, castCommand: cmd, castSays: out, expected: f.verifyBaseline.expected, baselineBuy: f.baselineBuy});
  check(`cast answers expected for ${f.intentHash}`, out === f.verifyBaseline.expected, `${out} vs ${f.verifyBaseline.expected}`);
}

const balances = {};
for (const u of users) for (const [sym, t] of [["USDG", USDG], ["NVDA", NVDA], ["AAPL", AAPL]]) balances[`${u.address} ${sym}`] = String(await c.client.readContract({address: t, abi: erc20Abi, functionName: "balanceOf", args: [u.address]}));

const result = {
  note: "fork of mainnet 4663, local signers, not mainnet and not real flow",
  pinnedBlock: pin.block,
  settlement,
  batchId: String(batchId),
  finalizeTx: settled?.transactionHash ?? null,
  block: settled ? String(settled.blockNumber) : null,
  nettingRatioBps: receipt.totals.nettingRatioBps,
  totals: receipt.totals,
  casts,
  baselineMatches: casts.filter((x) => x.expected === x.baselineBuy).length,
  baselineDiffers: casts.filter((x) => x.expected !== x.baselineBuy).length,
  checks,
  balancesAfter: balances,
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = checks.every((x) => x.ok) ? 0 : 1;
