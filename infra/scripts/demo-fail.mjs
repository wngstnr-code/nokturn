// The three failure receipts demo.md section 3 needs, each from one command and
// from our own stack, the running API plus a bounded solver and indexer this
// script starts itself. The solver has to be its own process because the
// expired case kills it between submit and finalize.
//
//   node infra/scripts/demo-fail.mjs --case passthrough | expired | unwound
//
// passthrough  two intents on the same side, nothing to net, everything routed.
//              It settles, saves nothing, and carries SavingsBelowThreshold.
// expired      the solver is killed once its solution is on chain, and
//              expireBatch is called from another account after the deadline.
// unwound      the owner of one leg moves their sell balance after the
//              solution is on chain, so finalize cannot collect it.
//
// Stop make solver first. A second solverA process would finalize the batch
// this script is trying to leave unfinalized.
//
// Fork only. Local signers on a fork of mainnet 4663, not mainnet and not real
// flow. Each receipt is saved to infra/.torture/receipt-<case>.json.

import {spawn} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {encodeFunctionData, erc20Abi, parseEventLogs, parseUnits} from "viem";
import {mnemonicToAccount} from "viem/accounts";
import {chain, settlementAbi} from "../../api/src/chain.ts";
import {quote} from "../../solver/src/baseline.ts";
import {expire} from "./expire.mjs";
import {buildSignedIntent} from "./sign-intent.mjs";

const CASES = ["passthrough", "expired", "unwound"];
/** Batches tried before the case gives up and reports what it saw. */
const MAX_ATTEMPTS = 3;
/** Chain minutes a solver runs for one attempt. One batch and its finalize. */
const SOLVER_MINUTES = "3";
/** Chain minutes the indexer runs for the whole case, the expired wait included. */
const INDEXER_MINUTES = "15";

const API = process.env.NOKTURN_API_URL ?? "http://127.0.0.1:3000";
const here = new URL(".", import.meta.url);
const root = new URL("../../", here);
const accounts = JSON.parse(readFileSync(new URL("../accounts.json", here), "utf8"));
const pin = JSON.parse(readFileSync(new URL("../pinned-block.json", here), "utf8"));
const MNEMONIC = process.env.NOKTURN_FORK_MNEMONIC ?? accounts._mnemonic;
const users = [0, 1, 2, 3].map((i) => {
  const a = mnemonicToAccount(MNEMONIC, {addressIndex: 6 + i});
  if (a.address.toLowerCase() !== accounts.users[i].toLowerCase()) throw new Error(`index ${6 + i} is not users[${i}]`);
  return a;
});

const c = chain();
const settlement = c.deployment.settlement;
const USDG = c.quote.address;
const NVDA = c.tokens.find((t) => t.symbol === "NVDA").token;

async function get(path) {
  const res = await fetch(`${API}${path}`);
  return {status: res.status, body: await res.json()};
}

async function venue(tokenIn, tokenOut, amount) {
  const q = await quote(c.client, c.deployment.adapter, tokenIn, tokenOut, amount, await c.client.getBlockNumber());
  if (!q.ok) throw new Error(`quoteFromState reverts ${q.error}`);
  return q.out;
}

/** Resolves with the first value check returns that is not undefined, or rejects past chain time `until`. */
function onBlocks(check, until, what) {
  return new Promise((resolve, reject) => {
    let busy = false;
    const unwatch = c.client.watchBlocks({
      emitOnBegin: true,
      pollingInterval: 500,
      onBlock: async (b) => {
        if (busy) return;
        busy = true;
        try {
          const v = await check(b);
          if (v !== undefined) {
            unwatch();
            resolve(v);
          } else if (b.timestamp > until) {
            unwatch();
            reject(new Error(`${what} did not happen by chain time ${until}`));
          }
        } catch (error) {
          unwatch();
          reject(error);
        } finally {
          busy = false;
        }
      },
    });
  });
}

async function freshBatch(after) {
  return onBlocks(
    async (b) => {
      const r = await get("/v1/batches/current");
      if (r.status !== 200) throw new Error(`GET /v1/batches/current answered ${r.status}`);
      const w = r.body;
      if (w.batchId !== null && BigInt(w.batchId) > after && w.collectEndsAt - w.chainTime >= 25) return w;
      return undefined;
    },
    (await c.client.getBlock()).timestamp + 600n,
    "an open batch with 25 seconds of collection left",
  );
}

/** Settlement events for one batch from `fromBlock` up to the block being looked at. */
async function batchLogs(batchId, fromBlock, toBlock) {
  const raw = await c.client.getLogs({address: settlement, fromBlock, toBlock});
  return parseEventLogs({abi: settlementAbi, logs: raw}).filter((l) => l.args.batchId === batchId);
}

function start(label, args, env = {}) {
  const p = spawn(process.execPath, args, {cwd: root, env: {...process.env, ...env}, stdio: ["ignore", "pipe", "pipe"]});
  const prefix = (d) => String(d).replace(/\n$/, "").replace(/^/gm, `[${label}] `) + "\n";
  p.stdout.on("data", (d) => process.stdout.write(prefix(d)));
  p.stderr.on("data", (d) => process.stderr.write(prefix(d)));
  const exited = new Promise((resolve) => p.on("exit", (code) => resolve(code)));
  return {kill: () => p.kill("SIGKILL"), exited};
}

async function post(account, fields) {
  const built = await buildSignedIntent({account, sellAmount: BigInt(fields.sellAmount), fields});
  const res = await fetch(`${API}/v1/intents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({intent: built.intent, signature: built.signature})});
  const body = await res.json();
  if (!res.ok) throw new Error(`POST /v1/intents answered ${res.status} ${JSON.stringify(body)}`);
  return body.batchId;
}

async function sendAs(from, to, data) {
  const hash = await c.client.request({method: "eth_sendTransaction", params: [{from, to, data, gas: "0x2dc6c0"}]});
  const r = await c.client.waitForTransactionReceipt({hash, pollingInterval: 250});
  if (r.status !== "success") throw new Error(`${hash} from ${from} reverted`);
  return hash;
}

const balanceOf = (token, owner) => c.client.readContract({address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner]});

/** Two opposite NVDA legs, both PARTIAL_FILL, which solve.ts nets in full. */
async function placeNetted(batch) {
  const sell = parseUnits("200", 6);
  const other = await venue(USDG, NVDA, parseUnits("150", 6));
  const legs = [
    [users[0], {sellToken: USDG, buyToken: NVDA, sellAmount: String(sell), minBuyAmount: String(((await venue(USDG, NVDA, sell)) * 99n) / 100n), flags: "1"}],
    [users[1], {sellToken: NVDA, buyToken: USDG, sellAmount: String(other), minBuyAmount: String(((await venue(NVDA, USDG, other)) * 99n) / 100n), flags: "1"}],
  ];
  for (const [account, fields] of legs) if ((await post(account, fields)) !== batch.batchId) throw new Error("a boundary fell between the submissions");
}

/** Two legs on the same side, so nothing can net and all of it is routed. */
async function placeSameSide(batch) {
  const legs = [
    [users[0], parseUnits("60", 6)],
    [users[2], parseUnits("40", 6)],
  ];
  for (const [account, sell] of legs) {
    const fields = {sellToken: USDG, buyToken: NVDA, sellAmount: String(sell), minBuyAmount: String(((await venue(USDG, NVDA, sell)) * 99n) / 100n), flags: "1"};
    if ((await post(account, fields)) !== batch.batchId) throw new Error("a boundary fell between the submissions");
  }
}

const EXPECT = {
  passthrough: {outcome: "settled", code: "SavingsBelowThreshold", reason: "savings below threshold"},
  expired: {outcome: "expired", code: "WinnerNeverFinalized", reason: "winner never finalized"},
  unwound: {outcome: "passthrough", code: "IntentCollectionFailed", reason: "intent could not be collected"},
};

async function attempt(name, after, log) {
  const batch = await freshBatch(after);
  const batchId = BigInt(batch.batchId);
  const fromBlock = await c.client.getBlockNumber();
  if (name === "passthrough") await placeSameSide(batch);
  else await placeNetted(batch);
  log(`intents placed in batch ${batchId}`);

  const solver = start("solver", ["solver/src/index.ts", "--run", "--duration", SOLVER_MINUTES], {NOKTURN_SOLVER_STATE: mkdtempSync(join(tmpdir(), `nokturn-demo-${name}-`))});
  const [, , solveEnd] = await c.client.readContract({address: settlement, abi: settlementAbi, functionName: "batchWindow", args: [batchId]});
  const deadline = BigInt(solveEnd) + BigInt(await c.client.readContract({address: settlement, abi: settlementAbi, functionName: "FINALIZE_DEADLINE"}));
  const seen = {batchId, fromBlock, mutation: null, expireTx: null};

  try {
    const submitted = await onBlocks(
      async (b) => (await batchLogs(batchId, fromBlock, b.number)).find((l) => l.eventName === "SolutionSubmitted"),
      BigInt(solveEnd) + 5n,
      `a SolutionSubmitted for batch ${batchId}`,
    ).catch(() => null);
    if (!submitted) return {batchId, ok: false, state: "no solution was submitted in the window"};
    log(`solution submitted by ${submitted.args.solver} in ${submitted.transactionHash}`);

    if (name === "expired") {
      solver.kill();
      log("solver killed before finalize");
      const e = await expire(batchId, {from: users[3].address, log});
      seen.expireTx = e.tx;
    } else if (name === "unwound") {
      const owner = users[1];
      const balance = await balanceOf(NVDA, owner.address);
      seen.mutation = {owner: owner.address, moved: String(balance), tx: await sendAs(owner.address, NVDA, encodeFunctionData({abi: erc20Abi, functionName: "transfer", args: [users[3].address, balance]}))};
      log(`${owner.address} moved ${balance} NVDA away after the submit`);
    }

    const closing = await onBlocks(
      async (b) => {
        const logs = await batchLogs(batchId, fromBlock, b.number);
        if (!logs.some((l) => l.eventName === "BatchPassthrough" || l.eventName === "BatchSettled")) return undefined;
        return logs;
      },
      deadline + 30n,
      `a closing event for batch ${batchId}`,
    ).catch(() => null);
    if (!closing) return {batchId, ok: false, state: "the batch never closed", ...seen};

    const receipt = await onBlocks(
      async () => {
        const r = await get(`/v1/batches/${batchId}`);
        return r.status === 200 && !["collecting", "solving"].includes(r.body.outcome) ? r.body : undefined;
      },
      (await c.client.getBlock()).timestamp + 120n,
      `the indexer to serve batch ${batchId}`,
    );
    return {batchId, ok: true, closing, receipt, ...seen};
  } finally {
    solver.kill();
    await solver.exited;
    // Hands the moved balance back, so the next run starts from the same books.
    if (seen.mutation) await sendAs(users[3].address, NVDA, encodeFunctionData({abi: erc20Abi, functionName: "transfer", args: [users[1].address, BigInt(seen.mutation.moved)]}));
  }
}

function verify(name, r) {
  const want = EXPECT[name];
  const checks = [];
  const check = (label, ok, detail) => checks.push({label, ok: Boolean(ok), detail});
  const passthrough = r.closing.find((l) => l.eventName === "BatchPassthrough");
  check(`BatchPassthrough "${want.reason}" on chain`, passthrough && passthrough.args.reason === want.reason, passthrough ? `${passthrough.args.reason} in ${passthrough.transactionHash}` : "none");
  check(`receipt outcome ${want.outcome}`, r.receipt.outcome === want.outcome, r.receipt.outcome);
  check(`failure code ${want.code}`, r.receipt.failure?.code === want.code, r.receipt.failure?.code ?? "no failure");
  check("feeCharged is 0", r.receipt.failure?.feeCharged === "0", r.receipt.failure?.feeCharged);
  if (name === "passthrough") {
    const settled = r.closing.find((l) => l.eventName === "BatchSettled");
    check("BatchSettled in the same finalize", settled && settled.transactionHash === passthrough?.transactionHash, settled?.transactionHash ?? "none");
    check("totalSavingsUsd is 0", r.receipt.totals.totalSavingsUsd === "0", r.receipt.totals.totalSavingsUsd);
    check("nothing netted", r.receipt.totals.nettedVolumeUsd === "0", r.receipt.totals.nettedVolumeUsd);
  }
  if (name === "expired") {
    check("receipt names the expireBatch transaction", r.receipt.provenance.transactionHash === r.expireTx?.toLowerCase(), r.receipt.provenance.transactionHash);
  }
  if (name === "unwound") {
    const failed = r.closing.find((l) => l.eventName === "IntentCollectionFailed");
    check("IntentCollectionFailed names the owner", failed && failed.args.owner.toLowerCase() === r.mutation.owner.toLowerCase(), failed ? failed.args.owner : "none");
    check("failure reason names the owner", r.receipt.failure?.reason.toLowerCase().includes(r.mutation.owner.toLowerCase()), r.receipt.failure?.reason);
  }
  return checks;
}

export async function demoFail(name, log = console.log) {
  if (!CASES.includes(name)) throw new Error(`--case must be one of ${CASES.join(", ")}`);
  try {
    await c.client.request({method: "anvil_nodeInfo", params: []});
  } catch {
    throw new Error("demo-fail changes fork state and only runs against an anvil fork, anvil_nodeInfo failed");
  }
  const health = await get("/v1/health").catch(() => null);
  if (!health || health.status !== 200) throw new Error(`the API at ${API} is not answering. run make api`);

  log(`fork of mainnet 4663 pinned at block ${pin.block}, local signers, not mainnet and not real flow. case ${name}`);
  const indexer = start("indexer", ["indexer/src/index.ts", "--duration", INDEXER_MINUTES]);
  const tried = [];
  let last = 0n;
  try {
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const r = await attempt(name, last, log);
      last = r.batchId;
      if (!r.ok) {
        tried.push({batchId: String(r.batchId), state: r.state});
        log(`attempt ${i} on batch ${r.batchId} did not reach the case, ${r.state}`);
        continue;
      }
      const checks = verify(name, r);
      mkdirSync(new URL("../.torture/", here), {recursive: true});
      writeFileSync(new URL(`../.torture/receipt-${name}.json`, here), JSON.stringify(r.receipt, null, 2));
      return {
        case: name,
        note: "fork of mainnet 4663, local signers, not mainnet and not real flow",
        pinnedBlock: pin.block,
        settlement,
        batchId: String(r.batchId),
        attempts: i,
        tried,
        closingTx: r.closing.at(-1).transactionHash,
        expireTx: r.expireTx,
        mutation: r.mutation,
        checks,
        saved: `infra/.torture/receipt-${name}.json`,
        ok: checks.every((x) => x.ok),
      };
    }
    return {case: name, ok: false, attempts: MAX_ATTEMPTS, tried, checks: []};
  } finally {
    indexer.kill();
    await indexer.exited;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--case");
  demoFail(i >= 0 ? argv[i + 1] : "")
    .then((result) => {
      console.log(JSON.stringify(result, (_, v) => (typeof v === "bigint" ? String(v) : v), 2));
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(`demo-fail failed\n  ${error.message}`);
      process.exitCode = 1;
    });
}
