// The F21 criterion read from the chain, not from the solver's summary.
//
//   node infra/scripts/f21-check.mjs --from <block>
//
// Nobody calls expireBatch on the fork, so a count of "winner never finalized"
// is zero whether or not the solver did its job. What would have been expired
// is counted too. A batch with a winning solution that is still not finalized
// once its deadline has passed is exactly what expireBatch slashes.

import {parseEventLogs} from "viem";
import {chain, initChain, settlementAbi} from "../../api/src/chain.ts";

const at = process.argv.indexOf("--from");
if (at < 0) {
  console.error("usage: node infra/scripts/f21-check.mjs --from <block>");
  process.exit(2);
}
const fromBlock = BigInt(process.argv[at + 1]);

process.env.NOKTURN_API_RPC ??= process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545";
await initChain();
const c = chain();
const settlement = c.deployment.settlement;
const head = await c.client.getBlock();
const logs = parseEventLogs({abi: settlementAbi, logs: await c.client.getLogs({address: settlement, fromBlock, toBlock: head.number})});

const counts = {};
const tally = (k) => (counts[k] = (counts[k] ?? 0) + 1);
const submitted = new Set();
const settled = new Set();
for (const l of logs) {
  if (l.eventName === "BatchPassthrough") tally(`BatchPassthrough "${l.args.reason}"`);
  else tally(l.eventName);
  if (l.eventName === "SolutionSubmitted") submitted.add(l.args.batchId);
  if (l.eventName === "BatchSettled") settled.add(l.args.batchId);
}

const expirable = [];
const pending = [];
for (const batchId of submitted) {
  const done = await c.client.readContract({address: settlement, abi: settlementAbi, functionName: "finalized", args: [batchId]});
  if (done) continue;
  if (head.timestamp > batchId + 10n + 300n) expirable.push(String(batchId));
  else pending.push(String(batchId));
}

const expired = counts['BatchPassthrough "winner never finalized"'] ?? 0;
console.log(`blocks ${fromBlock} to ${head.number}, chain time ${head.timestamp}, settlement ${settlement}`);
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(48)} ${v}`);
console.log(`  ${"batches with a submitted solution".padEnd(48)} ${submitted.size}`);
console.log(`  ${"batches settled".padEnd(48)} ${settled.size}`);
console.log(`  ${"won, unfinalized, past the deadline".padEnd(48)} ${expirable.length}${expirable.length ? ` ${expirable.join(" ")}` : ""}`);
console.log(`  ${"won, unfinalized, deadline still open".padEnd(48)} ${pending.length}${pending.length ? ` ${pending.join(" ")}` : ""}`);
const pass = expired === 0 && expirable.length === 0;
console.log(pass ? "F21 holds, nothing expired and nothing expirable" : "F21 FAILS");
// exitCode rather than exit, which trips a libuv assertion on Windows while a
// keep-alive socket is still closing and turns a pass into exit code 9.
process.exitCode = pass ? 0 : 1;
