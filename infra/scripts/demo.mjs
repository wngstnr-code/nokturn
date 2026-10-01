// make demo. One batch through the stack make up started, end to end, with no
// hand in between.
//
//   node infra/scripts/demo.mjs
//
// It never starts the stack itself. Two ways to start it would be two states
// to explain, so a stack that is not there is a message to run make up.
//
// Two opposite NVDA intents of uneven size, so the batch both nets and routes
// the rest. The close of collection, the winning solution and the settlement are
// all heard on /v1/stream, and the settled frame must carry the receipt that GET
// /v1/batches/:batchId serves. Fork only, local signers, not mainnet.

import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {API, freshBatch, pin, placeNetted, receiptOf, requireStack} from "./demo-lib.mjs";

const ATTEMPTS = 3;

const OUTCOME_FRAME_MS = 120_000;

function streamOf(batchId) {
  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/v1/stream`);
  const frames = [];
  let fail = () => {};
  const waiters = [];
  const waitFor = (pred, what) =>
    new Promise((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`no ${what} for batch ${batchId} on the stream in ${OUTCOME_FRAME_MS / 1000}s`)), OUTCOME_FRAME_MS);
      waiters.push({pred, resolve: (f) => (clearTimeout(timer), resolve(f)), reject});
    });
  const opened = new Promise((resolve, reject) => {
    fail = reject;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({type: "subscribe", topics: ["batch.collect_closed", "batch.solution_submitted", "batch.settled", "batch.failed"]}));
      resolve();
    });
  });
  ws.addEventListener("message", (m) => {
    const f = JSON.parse(String(m.data));
    if (f.code) {
      const error = new Error(`the stream refused the subscription, ${f.code} ${f.message}`);
      fail(error);
      for (const w of waiters.splice(0)) w.reject(error);
      return;
    }
    if (f.data?.batchId !== batchId) return;
    frames.push(f);
    for (const w of [...waiters]) {
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
    }
  });
  ws.addEventListener("error", () => fail(new Error(`the stream at ${API}/v1/stream failed`)));
  return {
    opened,
    closed: () => waitFor((f) => f.type === "batch.collect_closed", "collect_closed"),
    submitted: () => waitFor((f) => f.type === "batch.solution_submitted", "solution_submitted"),
    outcome: () => waitFor((f) => f.type === "batch.settled" || f.type === "batch.failed", "settled or failed frame"),
    stop: () => ws.close(),
  };
}

/** The settled frame carries the receipt GET serves, so the two must say the same thing. */
function sameReceipt(frame, receipt) {
  const pick = (r) => JSON.stringify({o: r.outcome, s: r.solver, f: r.fills.map((x) => [x.intentHash, x.executedSell, x.executedBuy, x.baselineBuy]), t: r.totals, p: r.provenance.transactionHash});
  return pick(frame) === pick(receipt);
}

export async function demo(log = console.log) {
  try {
    await requireStack("make demo");
  } catch (error) {
    throw new Error(`${error.message.replace(/ run make api$/, "")}. start the stack with make up`);
  }
  log(`make demo. fork of mainnet 4663 pinned at block ${pin.block}, local signers, not mainnet`);

  const tried = [];
  let after = 0n;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const batch = await freshBatch(after);
    after = BigInt(batch.batchId);
    const stream = streamOf(batch.batchId);
    try {
      await stream.opened;
      await placeNetted(batch, 300n * 10n ** 6n, 150n * 10n ** 6n);
      log(`two opposite intents placed in batch ${batch.batchId}`);
      await stream.closed();
      log(`collection closed on the stream`);
      const receipt = await receiptOf(after);
      tried.push({batchId: batch.batchId, outcome: receipt.outcome});
      if (receipt.outcome !== "settled") {
        log(`attempt ${attempt}, batch ${batch.batchId} ended ${receipt.outcome}`);
        continue;
      }
      const submitted = await stream.submitted();
      const outcome = await stream.outcome();
      if (outcome.type !== "batch.settled") throw new Error(`the stream said ${outcome.type} for a batch the receipt calls settled`);
      if (!sameReceipt(outcome.data, receipt)) throw new Error("the settled frame and GET /v1/batches/:batchId disagree");
      log(`solution and settlement heard on the stream, ${submitted.data.solver} with ${submitted.data.claimedSavingsUsd}`);
      return {receipt, attempts: attempt, tried};
    } catch (error) {
      tried.push({batchId: batch.batchId, error: error.message.split("\n")[0]});
      log(`attempt ${attempt}, batch ${batch.batchId}: ${error.message.split("\n")[0]}`);
    } finally {
      stream.stop();
    }
  }
  const err = new Error(`no batch settled in ${ATTEMPTS} attempts`);
  err.tried = tried;
  throw err;
}

function summary(receipt) {
  const floor = receipt.baselineFloors[0];
  return [
    `batch          ${receipt.batchId}, ${receipt.outcome}`,
    `finalize tx    ${receipt.provenance.transactionHash}`,
    `netting        ${Number(receipt.totals.nettingRatioBps) / 100} percent of the batch met another intent`,
    `savings        ${receipt.totals.totalSavingsUsd} USD in 18 decimals`,
    `verify a fill  ${receipt.fills[0].verifyBaseline.castCommand}`,
    `  expected     ${receipt.fills[0].verifyBaseline.expected}`,
    `verify floor   ${floor.verifyFloor.castCommand}`,
    `  expected     ${floor.verifyFloor.expected}, baseline sum ${floor.baselineBuy}, holds ${floor.holds}`,
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  demo()
    .then(({receipt}) => {
      const dir = join(fileURLToPath(new URL("..", import.meta.url)), ".torture");
      mkdirSync(dir, {recursive: true});
      writeFileSync(join(dir, "receipt-demo.json"), JSON.stringify(receipt, null, 2) + "\n");
      console.log(`\n${summary(receipt)}\n\nreceipt saved to infra/.torture/receipt-demo.json`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`make demo failed\n  ${error.message}`);
      if (error.tried) console.error(JSON.stringify(error.tried, null, 2));
      process.exit(1);
    });
}
