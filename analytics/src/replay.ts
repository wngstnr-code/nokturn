// F29, the harness. Plays the August fixture through the live stack, the API,
// the solver and the indexer that are already running, by signing each trade
// again with a local key and posting it as an intent.
//
//   node analytics/src/replay.ts --duration <chain minutes> [--speed <n>] [--fixture data/replay/august-2026.json]
//
// Paced by chain time, one block at a time, never by a timer. --speed 12 plays
// the fixture's hour in five chain minutes. It stops on its own, waits for the
// last batch it touched to be settled and indexed, and prints a summary.
//
// The netting it reports is what this replay measured on a fork, with every
// replayed trade going through Nokturn. It is not the 27 to 33 percent backtest
// and must never be quoted as that.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {erc20Abi, type Address, type Block} from "viem";
import {mnemonicToAccount, type HDAccount} from "viem/accounts";
import type {ApiError, BatchReceipt, NonceResponse} from "../../packages/shared/api-types.ts";
import {REPO_ROOT, type Fixture, type FixtureTrade} from "./extract.ts";

const API = process.env.NOKTURN_API_URL ?? "http://127.0.0.1:3000";
/** SessionManager.batchDuration(PROTECTIVE), the longest batch any session runs. */
const MAX_BATCH_SECONDS = 180n;
/** Chain seconds after the last solveEnd the harness waits for receipts before it reports what it has. */
const SETTLE_GRACE_SECONDS = 150n;
/** A balance that cannot cover a trade is spent down to this share, so the next trade from the same user still has something. */
const SHRINK_BPS = 9_000n;
/** 1 percent below the venue, the same margin m2.mjs and demo-fail.mjs use. */
const MIN_BUY_BPS = 9_900n;

/**
 * Codes that mean the harness built a bad intent, not that the market or a
 * cap said no. The pass condition is zero of these.
 */
export const HARNESS_FAULTS = new Set([
  "NonceAlreadyUsed",
  "IntentExpired",
  "SessionNotAllowed",
  "BatchMisaligned",
  "BatchInGuardBand",
  "COORDINATOR_BAD_SIGNATURE",
  "COORDINATOR_INVALID_REQUEST",
  "COORDINATOR_UNKNOWN_OWNER",
  "COORDINATOR_PERMIT2_NOT_APPROVED",
  "COORDINATOR_INSUFFICIENT_BALANCE",
  "COORDINATOR_DUPLICATE_INTENT",
]);

export interface Summary {
  sent: number;
  accepted: number;
  rejected: Record<string, number>;
  harnessFaults: number;
  shrunk: number;
  skippedNoBalance: number;
  fixtureTradesPlayed: number;
  fixtureTradesLeft: number;
  batches: number;
  batchesWithReceipt: number;
  batchesNetted: number;
  nettedVolumeUsd: string;
  routedVolumeUsd: string;
  nettingRatioBps: string;
  receiptsMissing: string[];
}

/** The trades due once `elapsed` chain seconds of the fixture have been played. */
export function due(queue: FixtureTrade[], elapsed: number): FixtureTrade[] {
  let n = 0;
  while (n < queue.length && queue[n]!.at <= elapsed) n += 1;
  return queue.splice(0, n);
}

/** Receipts only, so the number comes from what settled on chain, never from what was sent. */
export function nettingOf(receipts: BatchReceipt[]): {netted: bigint; routed: bigint; ratioBps: bigint; netting: number} {
  let netted = 0n;
  let routed = 0n;
  let netting = 0;
  for (const r of receipts) {
    const n = BigInt(r.totals.nettedVolumeUsd);
    netted += n;
    routed += BigInt(r.totals.routedVolumeUsd);
    if (n > 0n) netting += 1;
  }
  const total = netted + routed;
  return {netted, routed, ratioBps: total === 0n ? 0n : (netted * 10_000n) / total, netting};
}

async function getJson<T>(path: string): Promise<{status: number; body: T}> {
  const res = await fetch(`${API}${path}`);
  return {status: res.status, body: (await res.json()) as T};
}

export interface ReplayOptions {
  durationMinutes: number;
  speed?: number;
  fixturePath?: string;
  log?: (line: string) => void;
}

export async function replay(opts: ReplayOptions): Promise<Summary> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const speed = opts.speed ?? 1;
  if (!(opts.durationMinutes > 0)) throw new Error("--duration <chain minutes> is required and must be above zero");
  if (!(speed > 0)) throw new Error("--speed must be above zero");

  const fixture = JSON.parse(readFileSync(opts.fixturePath ?? join(REPO_ROOT, "data", "replay", "august-2026.json"), "utf8")) as Fixture;
  const sign = (await import("../../infra/scripts/sign-intent.mjs" as string)) as {buildSignedIntent: (o: object) => Promise<{intent: Record<string, string>; signature: string}>};
  const {chain} = await import("../../api/src/chain.ts");
  const {quote} = await import("../../solver/src/baseline.ts");
  const c = chain();
  try {
    await c.client.request({method: "anvil_nodeInfo" as never, params: [] as never});
  } catch {
    throw new Error("replay signs with local keys and only runs against an anvil fork, anvil_nodeInfo failed");
  }

  const accounts = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "accounts.json"), "utf8")) as {_mnemonic: string; users: string[]};
  const mnemonic = process.env.NOKTURN_FORK_MNEMONIC ?? accounts._mnemonic;
  const users: HDAccount[] = accounts.users.map((address, i) => {
    const a = mnemonicToAccount(mnemonic, {addressIndex: 6 + i});
    if (a.address.toLowerCase() !== address.toLowerCase()) throw new Error(`index ${6 + i} is not users[${i}]`);
    return a;
  });
  const pin = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "pinned-block.json"), "utf8")) as {block: number};
  const USDG = c.quote.address;
  const tokenOf = new Map(c.tokens.map((t) => [t.symbol, t.token as Address]));

  log(
    `replay: trade shape from Dune query ${fixture.source.queryId}, ${fixture.source.sourceTrades} trades in the off-hours hour from ${fixture.source.windowStart}, sizes scaled by ${fixture.scale.factor}. ` +
      `signed again by ${users.length} local keys, not the original ${fixture.traders} traders. real pools, real tokens and real prices on a fork of mainnet 4663 pinned at block ${pin.block}. not mainnet`,
  );

  const venue = async (tokenIn: Address, tokenOut: Address, amount: bigint) => {
    const q = await quote(c.client, c.deployment.adapter as Address, tokenIn, tokenOut, amount, await c.client.getBlockNumber());
    if (!q.ok) throw new Error(`quoteFromState ${q.error}`);
    return q.out;
  };

  // Permit2 nonces are a bitmap, so any unused one works. Each user's next is
  // read once and counted up here, because two intents from one user inside
  // the same block would otherwise both ask the API and both get the same one.
  const nonces = new Map<string, bigint>();
  const nextNonce = async (u: HDAccount) => {
    if (!nonces.has(u.address)) nonces.set(u.address, BigInt((await getJson<NonceResponse>(`/v1/nonces/${u.address}`)).body.next));
    const n = nonces.get(u.address)!;
    nonces.set(u.address, n + 1n);
    return n;
  };

  const summary: Summary = {sent: 0, accepted: 0, rejected: {}, harnessFaults: 0, shrunk: 0, skippedNoBalance: 0, fixtureTradesPlayed: 0, fixtureTradesLeft: 0, batches: 0, batchesWithReceipt: 0, batchesNetted: 0, nettedVolumeUsd: "0", routedVolumeUsd: "0", nettingRatioBps: "0", receiptsMissing: []};
  const batches = new Set<string>();

  const play = async (t: FixtureTrade) => {
    summary.fixtureTradesPlayed += 1;
    const user = users[t.trader % users.length]!;
    const stock = tokenOf.get(t.sym);
    if (!stock) throw new Error(`the deployment has no ${t.sym}`);
    const usd = BigInt(t.usdMicro);
    if (usd === 0n) return;
    const [sellToken, buyToken] = t.side === "buy" ? [USDG, stock] : [stock, USDG];
    let sellAmount = t.side === "buy" ? usd : await venue(USDG, stock, usd);
    const balance = (await c.client.readContract({address: sellToken, abi: erc20Abi, functionName: "balanceOf", args: [user.address]})) as bigint;
    if (balance < sellAmount) {
      sellAmount = (balance * SHRINK_BPS) / 10_000n;
      if (sellAmount === 0n) {
        summary.skippedNoBalance += 1;
        return;
      }
      summary.shrunk += 1;
    }
    const minBuyAmount = ((await venue(sellToken, buyToken, sellAmount)) * MIN_BUY_BPS) / 10_000n;
    const built = await sign.buildSignedIntent({account: user, sellAmount, fields: {sellToken, buyToken, sellAmount: String(sellAmount), minBuyAmount: String(minBuyAmount), flags: "1", nonce: String(await nextNonce(user))}});
    summary.sent += 1;
    const res = await fetch(`${API}/v1/intents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({intent: built.intent, signature: built.signature})});
    const body = (await res.json()) as {batchId?: string} & Partial<ApiError>;
    if (res.ok && body.batchId) {
      summary.accepted += 1;
      batches.add(body.batchId);
      return;
    }
    const code = String(body.code ?? `HTTP_${res.status}`);
    summary.rejected[code] = (summary.rejected[code] ?? 0) + 1;
    if (HARNESS_FAULTS.has(code)) {
      summary.harnessFaults += 1;
      log(`harness fault ${code} for trade ${t.txHash}:${t.logIndex}, ${body.message ?? ""}`);
    }
  };

  const queue = [...fixture.trades].sort((a, b) => a.at - b.at);
  const t0 = (await c.client.getBlock()).timestamp;
  const endAt = t0 + BigInt(Math.round(opts.durationMinutes * 60));

  await new Promise<void>((resolve, reject) => {
    let busy = false;
    const unwatch = c.client.watchBlocks({
      emitOnBegin: true,
      pollingInterval: 500,
      onBlock: async (b: Block) => {
        if (busy) return;
        busy = true;
        try {
          const elapsed = Number(b.timestamp - t0) * speed;
          for (const t of due(queue, elapsed)) await play(t);
          if (b.timestamp >= endAt || queue.length === 0) {
            unwatch();
            resolve();
          }
        } catch (error) {
          unwatch();
          reject(error);
        } finally {
          busy = false;
        }
      },
      onError: (error) => {
        unwatch();
        reject(error);
      },
    });
  });
  summary.fixtureTradesLeft = queue.length;
  summary.batches = batches.size;
  log(`sent ${summary.sent}, accepted ${summary.accepted}, into ${batches.size} batches. waiting for them to settle and be indexed`);

  const receipts = await collect(c.client, [...batches], log);
  summary.batchesWithReceipt = receipts.found.length;
  summary.receiptsMissing = receipts.missing;
  const n = nettingOf(receipts.found);
  summary.batchesNetted = n.netting;
  summary.nettedVolumeUsd = String(n.netted);
  summary.routedVolumeUsd = String(n.routed);
  summary.nettingRatioBps = String(n.ratioBps);
  return summary;
}

/** Waits by block until every batch has a final receipt or the grace after the last one runs out. */
async function collect(client: import("viem").PublicClient, batchIds: string[], log: (l: string) => void): Promise<{found: BatchReceipt[]; missing: string[]}> {
  if (batchIds.length === 0) return {found: [], missing: []};
  const last = batchIds.map(BigInt).reduce((a, b) => (b > a ? b : a));
  const found = new Map<string, BatchReceipt>();
  // A batchId is its start time, and no session runs a batch longer than
  // MAX_BATCH_SECONDS, so the last solveEnd is at most that plus the window.
  const until = last + MAX_BATCH_SECONDS + SETTLE_GRACE_SECONDS;
  await new Promise<void>((resolve) => {
    let busy = false;
    const unwatch = client.watchBlocks({
      emitOnBegin: true,
      pollingInterval: 1_000,
      onBlock: async (b: Block) => {
        if (busy) return;
        busy = true;
        try {
          for (const id of batchIds) {
            if (found.has(id)) continue;
            const r = await getJson<BatchReceipt>(`/v1/batches/${id}`);
            if (r.status === 200 && !["collecting", "solving"].includes(r.body.outcome)) found.set(id, r.body);
          }
          if (found.size === batchIds.length || b.timestamp > until) {
            unwatch();
            resolve();
          }
        } catch (error) {
          log(`receipt read failed, ${(error as Error).message.split("\n")[0]}`);
        } finally {
          busy = false;
        }
      },
      onError: () => {
        unwatch();
        resolve();
      },
    });
  });
  return {found: [...found.values()], missing: batchIds.filter((id) => !found.has(id))};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const duration = flag("--duration");
  if (duration === undefined) {
    console.error("usage: node analytics/src/replay.ts --duration <chain minutes> [--speed <n>] [--fixture <path>]");
    process.exit(2);
  }
  replay({durationMinutes: Number(duration), speed: flag("--speed") ? Number(flag("--speed")) : undefined, fixturePath: flag("--fixture")})
    .then((s) => {
      console.log(JSON.stringify({...s, note: "netting measured by this replay on a fork, every replayed trade through Nokturn. not the 27 to 33 percent backtest"}, null, 2));
      process.exitCode = s.harnessFaults === 0 && s.batchesNetted > 0 ? 0 : 1;
    })
    .catch((error) => {
      console.error(`replay failed\n  ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
