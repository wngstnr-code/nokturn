// Differential check for packages/shared/batch.ts against the deployed
// Settlement.
//
// The rule this enforces is the same one the baseline calculator lives under.
// Two implementations that disagree are worse than one, so the helper is only
// trustworthy while every batchId it hands out is one the contract accepts, and
// every batchId it refuses is one the contract rejects. Both directions are
// checked here, because a helper that is merely conservative would pass a one
// sided test while quietly skipping usable batches.
//
// It moves the fork clock, so it snapshots first and reverts at the end. The
// clock only ever moves forward inside a run, because evm_setNextBlockTimestamp
// refuses to go backwards and the walk below ends hours ahead of where it began.

import {readFileSync} from "node:fs";
import {createPublicClient, http} from "viem";
import {
  nextValidBatchId,
  solvableBatchId,
  isValidBatchId,
  isBatch,
} from "../../packages/shared/batch.ts";
import {createChainReader} from "../../packages/shared/batch-viem.ts";

const RPC = process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545";
const here = new URL(".", import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, here), "utf8"));
const d = readJson("../fork-deployment.json");

const client = createPublicClient({
  chain: {
    id: 4663,
    name: "fork",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [RPC]}},
  },
  transport: http(RPC),
});

const settlementAbi = [
  {
    type: "function",
    name: "batchWindow",
    stateMutability: "view",
    inputs: [{name: "batchId", type: "uint64"}],
    outputs: [{type: "uint64"}, {type: "uint64"}, {type: "uint64"}],
  },
];

const SESSIONS = [
  "CLOSED_OVERNIGHT",
  "PRE_MARKET",
  "AUCTION_OPEN",
  "OPEN",
  "AUCTION_CLOSE",
  "POST_MARKET",
  "CLOSED_WEEKEND",
  "HOLIDAY",
  "PROTECTIVE",
];

const rpc = (method, params) => client.transport.request({method, params});
const reader = createChainReader(client, d.sessions);

let pass = 0;
let fail = 0;
const ok = (label, extra = "") => {
  pass += 1;
  console.log(`  ok    ${label}${extra ? `  ${extra}` : ""}`);
};
const bad = (label, detail) => {
  fail += 1;
  console.log(`  FAIL  ${label}\n        ${detail}`);
};

async function chainWindow(batchId) {
  try {
    const [collectStart, collectEnd, solveEnd] = await client.readContract({
      address: d.settlement,
      abi: settlementAbi,
      functionName: "batchWindow",
      args: [batchId],
    });
    return {collectStart, collectEnd, solveEnd};
  } catch (error) {
    const name = error.cause?.data?.errorName ?? error.cause?.cause?.data?.errorName ?? "revert";
    return {error: name};
  }
}

async function jumpTo(timestamp) {
  await rpc("evm_setNextBlockTimestamp", [`0x${timestamp.toString(16)}`]);
  await rpc("evm_mine", []);
}

/** The helper must agree with the contract, in both directions. */
async function checkAt(label, timestamp) {
  await jumpTo(timestamp);
  const session = await reader.sessionAt(timestamp);
  const tag = SESSIONS[session];

  const result = await nextValidBatchId(reader, timestamp);

  if (!isBatch(result)) {
    let usable = null;
    for (let t = timestamp + 1n; t < timestamp + 400n; t += 1n) {
      if (await isValidBatchId(reader, t)) {
        const w = await chainWindow(t);
        if (!w.error) {
          usable = t;
          break;
        }
      }
    }
    if (usable === null) ok(`${label} (${tag})`, `refused, ${result.reason}, nothing nearby was usable`);
    else bad(label, `helper refused but ${usable} is accepted by the contract`);
    return;
  }

  const onchain = await chainWindow(result.batchId);
  if (onchain.error) {
    bad(label, `helper offered ${result.batchId} but the contract said ${onchain.error}`);
    return;
  }
  if (
    onchain.collectStart !== result.collectStart ||
    onchain.collectEnd !== result.collectEnd ||
    onchain.solveEnd !== result.solveEnd
  ) {
    bad(
      label,
      `window mismatch. helper ${result.collectStart}/${result.collectEnd}/${result.solveEnd} vs ` +
        `chain ${onchain.collectStart}/${onchain.collectEnd}/${onchain.solveEnd}`,
    );
    return;
  }

  // Nothing between the query time and the offered id may be usable, or the
  // helper skipped a batch it should have offered. This is the direction a one
  // sided test would miss.
  for (let t = timestamp + 1n; t < result.batchId; t += 1n) {
    if (await isValidBatchId(reader, t)) {
      const w = await chainWindow(t);
      if (!w.error) {
        bad(label, `helper skipped ${t}, which the contract accepts`);
        return;
      }
    }
  }

  ok(`${label} (${tag})`, `-> ${result.batchId}, ${result.durationSeconds}s`);
}

async function main() {
  const snap = await rpc("evm_snapshot", []);
  console.log(`snapshot ${snap}\n`);

  try {
    const start = (await client.getBlock()).timestamp;
    const transition = await reader.nextTransition(start);
    console.log(`chain at    ${start}  ${new Date(Number(start) * 1000).toISOString()}`);
    console.log(`transition  ${transition}  ${new Date(Number(transition) * 1000).toISOString()}\n`);

    console.log("nextValidBatchId agrees with batchWindow:");
    await checkAt("ordinary weekend time", start + 5n);
    await checkAt("one second before a boundary", (start / 60n) * 60n + 119n);
    await checkAt("exactly on a boundary", (start / 60n + 4n) * 60n);
    await checkAt("120s before the transition", transition - 120n);
    await checkAt("inside the guard band, before", transition - 30n);
    await checkAt("exactly at the transition", transition);
    await checkAt("inside the guard band, after", transition + 30n);
    await checkAt("the R4 trap, 60s after", transition + 60n);
    await checkAt("clear of the band", transition + 200n);

    // Walk a whole weekday so the auction phases, the ten second OPEN batches
    // and the thirty second market edges all get hit.
    console.log("\nwalking a full weekday, every 37 minutes:");
    const dayStart = transition + 3600n;
    for (let i = 0n; i < 26n; i += 1n) {
      await checkAt(`+${String(i * 37n).padStart(4)}min`, dayStart + i * 2220n);
    }

    console.log("\nsolvableBatchId tracks the ten second window:");
    // Built from where the walk left the clock, not from where the run started.
    const resume = (await client.getBlock()).timestamp;
    const resumeSession = await reader.sessionAt(resume);
    const resumeDuration = BigInt(await reader.batchDuration(resumeSession));
    const base = (resume / resumeDuration + 2n) * resumeDuration;

    for (const offset of [0n, 1n, 5n, 10n, 11n, resumeDuration - 1n]) {
      await jumpTo(base + offset);
      const r = await solvableBatchId(reader, base + offset);
      const expected = offset >= 1n && offset <= 10n;
      if (isBatch(r) === expected) {
        ok(
          `offset ${String(offset).padStart(2)} of ${resumeDuration}s`,
          expected ? `open, batch ${r.batchId}` : `closed, ${r.reason}`,
        );
      } else {
        bad(
          `offset ${offset}`,
          `expected ${expected ? "open" : "closed"}, got ${isBatch(r) ? "open" : r.reason}`,
        );
      }
    }
  } finally {
    const reverted = await rpc("evm_revert", [snap]);
    console.log(`\nreverted ${snap} -> ${reverted}`);
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
}

await main();
