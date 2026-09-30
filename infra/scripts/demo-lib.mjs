// What demo-fail.mjs and demo-compete.mjs share. Fork only, local signers, and
// every wait moves with blocks rather than the laptop clock.

import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {parseEventLogs} from "viem";
import {mnemonicToAccount} from "viem/accounts";
import {chain, settlementAbi} from "../../api/src/chain.ts";
import {quote} from "../../solver/src/baseline.ts";
import {buildSignedIntent} from "./sign-intent.mjs";

export const API = process.env.NOKTURN_API_URL ?? "http://127.0.0.1:3000";
const here = new URL(".", import.meta.url);
export const root = new URL("../../", here);
export const accounts = JSON.parse(readFileSync(new URL("../accounts.json", here), "utf8"));
export const pin = JSON.parse(readFileSync(new URL("../pinned-block.json", here), "utf8"));
const MNEMONIC = process.env.NOKTURN_FORK_MNEMONIC ?? accounts._mnemonic;
export const users = accounts.users.map((address, i) => {
  const a = mnemonicToAccount(MNEMONIC, {addressIndex: 6 + i});
  if (a.address.toLowerCase() !== address.toLowerCase()) throw new Error(`index ${6 + i} is not users[${i}]`);
  return a;
});

export const c = chain();
export const settlement = c.deployment.settlement;
export const USDG = c.quote.address;
export const NVDA = c.tokens.find((t) => t.symbol === "NVDA").token;

export async function requireStack(what) {
  try {
    await c.client.request({method: "anvil_nodeInfo", params: []});
  } catch {
    throw new Error(`${what} changes fork state and only runs against an anvil fork, anvil_nodeInfo failed`);
  }
  const health = await get("/v1/health").catch(() => null);
  if (!health || health.status !== 200) throw new Error(`the API at ${API} is not answering. run make api`);
}

export async function get(path) {
  const res = await fetch(`${API}${path}`);
  return {status: res.status, body: await res.json()};
}

export async function venue(tokenIn, tokenOut, amount) {
  const q = await quote(c.client, c.deployment.adapter, tokenIn, tokenOut, amount, await c.client.getBlockNumber());
  if (!q.ok) throw new Error(`quoteFromState reverts ${q.error}`);
  return q.out;
}

/** Resolves with the first value check returns that is not undefined, or rejects past chain time `until`. */
export function onBlocks(check, until, what) {
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

/** The first batch after `after` with 25 seconds of collection left. */
export async function freshBatch(after) {
  return onBlocks(
    async () => {
      const r = await get("/v1/batches/current");
      if (r.status !== 200) throw new Error(`GET /v1/batches/current answered ${r.status}`);
      const w = r.body;
      // Empty as well. Every caller asserts what its own intents did, and the
      // mempool does not rewind with evm_revert, so a batch reused after a
      // reverted run still holds that run's intents, and the solvers solve those.
      return w.batchId !== null && BigInt(w.batchId) > after && w.intentCount === 0 && w.collectEndsAt - w.chainTime >= 25 ? w : undefined;
    },
    (await c.client.getBlock()).timestamp + 600n,
    "an empty open batch with 25 seconds of collection left",
  );
}

/** Settlement events for one batch between two blocks. */
export async function batchLogs(batchId, fromBlock, toBlock) {
  const raw = await c.client.getLogs({address: settlement, fromBlock, toBlock});
  return parseEventLogs({abi: settlementAbi, logs: raw}).filter((l) => l.args.batchId === batchId);
}

/** Every log in a range, parsed against any abi, for events that carry no batchId. */
export async function logsOf(address, abi, fromBlock, toBlock) {
  return parseEventLogs({abi, logs: await c.client.getLogs({address, fromBlock, toBlock})});
}

export function start(label, args, env = {}) {
  const p = spawn(process.execPath, args, {cwd: root, env: {...process.env, ...env}, stdio: ["ignore", "pipe", "pipe"]});
  const prefix = (d) => String(d).replace(/\n$/, "").replace(/^/gm, `[${label}] `) + "\n";
  p.stdout.on("data", (d) => process.stdout.write(prefix(d)));
  p.stderr.on("data", (d) => process.stderr.write(prefix(d)));
  const exited = new Promise((resolve) => p.on("exit", (code) => resolve(code)));
  return {kill: () => p.kill("SIGKILL"), exited};
}

export async function post(account, fields) {
  const built = await buildSignedIntent({account, sellAmount: BigInt(fields.sellAmount), fields});
  const res = await fetch(`${API}/v1/intents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({intent: built.intent, signature: built.signature})});
  const body = await res.json();
  if (!res.ok) throw new Error(`POST /v1/intents answered ${res.status} ${JSON.stringify(body)}`);
  return body.batchId;
}

export async function sendAs(from, to, data) {
  const hash = await c.client.request({method: "eth_sendTransaction", params: [{from, to, data, gas: "0x2dc6c0"}]});
  const r = await c.client.waitForTransactionReceipt({hash, pollingInterval: 250});
  if (r.status !== "success") throw new Error(`${hash} from ${from} reverted`);
  return hash;
}

/**
 * Two opposite NVDA legs, both PARTIAL_FILL, which solve.ts nets in full.
 * users[0] buys with `usdg`, users[1] sells what `against` USDG buys at the venue.
 */
export async function placeNetted(batch, usdg = 200n * 10n ** 6n, against = 150n * 10n ** 6n) {
  const other = await venue(USDG, NVDA, against);
  const legs = [
    [users[0], {sellToken: USDG, buyToken: NVDA, sellAmount: String(usdg), minBuyAmount: String(((await venue(USDG, NVDA, usdg)) * 99n) / 100n), flags: "1"}],
    [users[1], {sellToken: NVDA, buyToken: USDG, sellAmount: String(other), minBuyAmount: String(((await venue(NVDA, USDG, other)) * 99n) / 100n), flags: "1"}],
  ];
  for (const [account, fields] of legs) if ((await post(account, fields)) !== batch.batchId) throw new Error("a boundary fell between the submissions");
}

/** Two legs on the same side, so nothing can net and all of it is routed. */
export async function placeSameSide(batch) {
  for (const [account, sell] of [[users[0], 60n * 10n ** 6n], [users[2], 40n * 10n ** 6n]]) {
    const fields = {sellToken: USDG, buyToken: NVDA, sellAmount: String(sell), minBuyAmount: String(((await venue(USDG, NVDA, sell)) * 99n) / 100n), flags: "1"};
    if ((await post(account, fields)) !== batch.batchId) throw new Error("a boundary fell between the submissions");
  }
}

/** Waits by block for the API to serve a final receipt for the batch. */
export async function receiptOf(batchId, graceSeconds = 120n) {
  return onBlocks(
    async () => {
      const r = await get(`/v1/batches/${batchId}`);
      return r.status === 200 && !["collecting", "solving"].includes(r.body.outcome) ? r.body : undefined;
    },
    (await c.client.getBlock()).timestamp + graceSeconds,
    `the indexer to serve batch ${batchId}`,
  );
}
