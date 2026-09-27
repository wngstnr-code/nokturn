// F23. Two solvers compete for the same batch, and the chain says who won.
//
//   node infra/scripts/demo-compete.mjs [--batches <n>] [--same-side]
//
// solverA runs profile a, netting first. solverB runs profile b, routing every
// intent the way an aggregator would. Two opposite intents give a something to
// net, so it should save more and win. --same-side places two intents on one
// side instead, where both profiles route the same volume and save nothing,
// and the first to arrive wins.
//
// Which solution arrives first is a race between two processes. When b lands
// after a, Settlement emits SolutionRejected("not the best") for it. When b
// lands first, it is best for a moment and a replaces it without any rejection
// event, so that check is made only when the order calls for it, and the order
// is reported either way.
//
// Stop make solver first. Fork only, local signers, not mainnet and not real
// flow. The receipt of the first batch is saved to infra/.torture/receipt-compete.json.

import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {hexToString} from "viem";
import {settlementAbi} from "../../api/src/chain.ts";
import {accounts, batchLogs, c, freshBatch, logsOf, onBlocks, pin, placeNetted, placeSameSide, receiptOf, requireStack, settlement, start} from "./demo-lib.mjs";

const registryAbi = JSON.parse(readFileSync(new URL("../../packages/shared/abi/SolverRegistry.json", import.meta.url), "utf8"));
const A = accounts.solverA.toLowerCase();
const B = accounts.solverB.toLowerCase();
const name = (a) => (a.toLowerCase() === A ? "solverA" : a.toLowerCase() === B ? "solverB" : a);
// SolutionRejected carries its reason as bytes32, right padded with zeros.
const reasonOf = (l) => hexToString(l.args.reason, {size: 32});

async function oneBatch(after, sameSide, log) {
  const batch = await freshBatch(after);
  const batchId = BigInt(batch.batchId);
  const fromBlock = await c.client.getBlockNumber();
  if (sameSide) await placeSameSide(batch);
  // Uneven on purpose, so profile a nets the overlap and routes the rest,
  // which leaves it a real savings figure to beat profile b's zero with.
  else await placeNetted(batch, 300n * 10n ** 6n, 150n * 10n ** 6n);
  log(`intents placed in batch ${batchId}`);

  const [, , solveEnd] = await c.client.readContract({address: settlement, abi: settlementAbi, functionName: "batchWindow", args: [batchId]});
  const deadline = BigInt(solveEnd) + BigInt(await c.client.readContract({address: settlement, abi: settlementAbi, functionName: "FINALIZE_DEADLINE"}));
  const closing = await onBlocks(
    async (b) => {
      const logs = await batchLogs(batchId, fromBlock, b.number);
      return logs.some((l) => l.eventName === "BatchSettled" || l.eventName === "BatchPassthrough") ? {logs, toBlock: b.number} : undefined;
    },
    deadline + 30n,
    `batch ${batchId} to close`,
  );
  const registry = await c.client.readContract({address: settlement, abi: settlementAbi, functionName: "solvers"});
  const settled = closing.logs.find((l) => l.eventName === "BatchSettled");
  const scores = settled ? (await logsOf(registry, registryAbi, settled.blockNumber, settled.blockNumber)).filter((l) => l.eventName === "SolverScoreUpdated" && l.transactionHash === settled.transactionHash) : [];
  return {batchId, logs: closing.logs, settled, scores, receipt: await receiptOf(batchId)};
}

function verify(r, sameSide) {
  const checks = [];
  const check = (label, ok, detail) => checks.push({label, ok: Boolean(ok), detail});
  const byOrder = (x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1);
  const submits = r.logs.filter((l) => l.eventName === "SolutionSubmitted").sort(byOrder);
  const rejected = r.logs.filter((l) => l.eventName === "SolutionRejected");
  const solvers = new Set(submits.map((l) => l.args.solver.toLowerCase()));
  const order = submits.map((l) => `${name(l.args.solver)} ${l.args.claimedSavings}`);

  check("two SolutionSubmitted from two different solvers", submits.length === 2 && solvers.size === 2, order);
  check("the batch settled", r.settled, r.settled?.transactionHash ?? r.logs.map((l) => l.eventName));
  const winner = r.settled?.args.solver.toLowerCase();
  const best = submits.reduce((a, s) => (a && a.args.claimedSavings >= s.args.claimedSavings ? a : s), null);
  if (sameSide) {
    check("equal savings, so the first to arrive wins", submits.length === 2 && submits[0].args.claimedSavings === submits[1].args.claimedSavings && winner === submits[0].args.solver.toLowerCase(), {order, winner: winner && name(winner)});
  } else {
    check("the higher savings wins, and it is profile a", winner === A && best?.args.solver.toLowerCase() === A && submits.every((s) => s === best || s.args.claimedSavings < best.args.claimedSavings), {order, winner: winner && name(winner)});
  }
  const loser = submits.find((s) => s.args.solver.toLowerCase() !== winner);
  const loserCameSecond = loser && submits.indexOf(loser) === 1;
  if (loserCameSecond) {
    check('the loser, arriving second, got SolutionRejected("not the best")', rejected.some((l) => l.args.solver.toLowerCase() === loser.args.solver.toLowerCase() && reasonOf(l) === "not the best"), rejected.map((l) => `${name(l.args.solver)} ${reasonOf(l)}`));
  } else {
    check("the loser arrived first and was replaced, which emits no rejection", rejected.length === 0, {order, rejected: rejected.map((l) => `${name(l.args.solver)} ${reasonOf(l)}`)});
  }
  const listed = r.receipt.solutions.map((s) => s.solver.toLowerCase());
  check("solutions[] carries both, with claimedSavingsUsd", solvers.size === 2 && [...solvers].every((s) => listed.includes(s)) && r.receipt.solutions.every((s) => s.claimedSavingsUsd !== undefined), r.receipt.solutions.map((s) => `${name(s.solver)} ${s.claimedSavingsUsd} accepted ${s.accepted}`));
  check("SolverScoreUpdated for the winner only", r.scores.length === 1 && r.scores[0].args.solver.toLowerCase() === winner, r.scores.map((l) => name(l.args.solver)));
  return {checks, order, loserCameSecond: Boolean(loserCameSecond)};
}

export async function compete({batches = 1, sameSide = false, log = console.log} = {}) {
  await requireStack("demo-compete");
  log(`fork of mainnet 4663 pinned at block ${pin.block}, local signers, not mainnet and not real flow. ${batches} batch${batches === 1 ? "" : "es"}, ${sameSide ? "same side" : "opposite sides"}`);
  // Every batch is at most a minute plus its finalize, so this outlasts the run.
  const minutes = String(3 + batches * 2);
  const indexer = start("indexer", ["indexer/src/index.ts", "--duration", minutes]);
  const state = mkdtempSync(join(tmpdir(), "nokturn-compete-"));
  const a = start("solverA", ["solver/src/index.ts", "--run", "--duration", minutes, "--profile", "a"], {NOKTURN_SOLVER_STATE: state});
  const b = start("solverB", ["solver/src/index.ts", "--run", "--duration", minutes, "--profile", "b"], {NOKTURN_SOLVER_STATE: state});
  const out = [];
  try {
    let last = 0n;
    for (let i = 0; i < batches; i += 1) {
      const r = await oneBatch(last, sameSide, log);
      last = r.batchId;
      const v = verify(r, sameSide);
      if (i === 0) {
        mkdirSync(new URL("../.torture/", import.meta.url), {recursive: true});
        writeFileSync(new URL(`../.torture/receipt-compete${sameSide ? "-same-side" : ""}.json`, import.meta.url), JSON.stringify(r.receipt, null, 2));
      }
      out.push({batchId: String(r.batchId), finalizeTx: r.settled?.transactionHash ?? null, ...v, ok: v.checks.every((x) => x.ok)});
    }
  } finally {
    for (const p of [a, b, indexer]) p.kill();
    await Promise.all([a.exited, b.exited, indexer.exited]);
  }
  return {note: "fork of mainnet 4663, local signers, not mainnet and not real flow", pinnedBlock: pin.block, settlement, sameSide, batches: out, ok: out.length === batches && out.every((x) => x.ok)};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--batches");
  compete({batches: i >= 0 ? Number(argv[i + 1]) : 1, sameSide: argv.includes("--same-side")})
    .then((result) => {
      console.log(JSON.stringify(result, (_, v) => (typeof v === "bigint" ? String(v) : v), 2));
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(`demo-compete failed\n  ${error.message}`);
      process.exitCode = 1;
    });
}
