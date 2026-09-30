// The auction keeper.
//
//   node solver/src/keeper.ts [--duration <chain minutes>] [--profile a|b]
//
// Opens, publishes, freezes, crosses and executes the opening and closing
// auctions, following contracts/src/AuctionHouse.sol rather than the design
// docs. Every step is a function anyone can call, except submitCross, which
// needs an active solver, and that is why the keeper runs as one.
//
// Driven by blocks, never by a timer. Everything it acts on is read from the
// chain at each block, including which auctions exist, so a keeper killed in
// the middle of a cycle picks up where the chain is rather than where its
// memory was. At most one transaction per auction per block. A revert is logged
// by name and that action is not tried again for that auction, except when the
// contract only says it is too early.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";
import {encodeFunctionData, erc20Abi, type Abi, type Address, type Hex, type PublicClient} from "viem";
import type {HDAccount} from "viem/accounts";
import {assertBare, solverAccount, type Profile} from "./account.ts";
import {REPO_ROOT, loadAbi, oracleAbi, sessionAbi} from "./abi.ts";
import {client, revertName, withRetry} from "./chain.ts";
import {planCross, ymdOf, type BookEntry} from "./cross.ts";
import {wallet} from "./send.ts";

const houseAbi = (): Abi => loadAbi("AuctionHouse");

/** Session in contracts/src/types/Types.sol. */
const SESSION = {AUCTION_OPEN: 2, OPEN: 3, AUCTION_CLOSE: 4, POST_MARKET: 5} as const;
const KIND_OPEN = 0;
const KIND_CLOSE = 1;
const PHASE = ["NONE", "DISCLOSURE", "FROZEN", "CROSSED", "EXECUTED", "ABORTED"] as const;
type PhaseName = (typeof PHASE)[number];

/** AuctionHouse keeps at most this many auctions worth scanning after a restart. */
const RESCAN = 32n;
/**
 * abortAuction's own deadline is referenceAt plus four extension periods, 1200
 * seconds. Past that plus this margin the keeper lets go and says why, so an
 * auction the chain will not let it close cannot hold it forever.
 */
const RELEASE_AFTER = 1_800n;
/** Reverts that mean wait, not stop. */
const WAIT = /^(TooEarly|AuctionStillLive)\b/;

interface DeploymentRecord {
  auctionHouse: Address;
  sessions: Address;
  oracle: Address;
}

function record(): DeploymentRecord {
  const path = process.env.NOKTURN_SOLVER_DEPLOYMENT ?? join(REPO_ROOT, "infra", "fork-deployment.json");
  const r = JSON.parse(readFileSync(path, "utf8")) as Partial<DeploymentRecord>;
  if (!r.auctionHouse || !r.sessions || !r.oracle) throw new Error(`${path} names no auctionHouse, sessions or oracle. run make deploy`);
  return r as DeploymentRecord;
}

function tokenList(): {symbol: string; token: Address}[] {
  const chain = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "chain.json"), "utf8")) as {tokens: Record<string, {token: Address}>};
  return Object.entries(chain.tokens).map(([symbol, t]) => ({symbol, token: t.token}));
}

export interface KeeperOptions {
  durationMinutes?: number;
  profile?: Profile;
  log?: (line: string) => void;
  /** Checked between blocks. Lets a test stop the keeper mid cycle, K3. */
  stopWhen?: () => boolean;
}

export interface KeeperSummary {
  blocks: number;
  sent: Record<string, number>;
  reverted: Record<string, number>;
  released: string[];
}

export async function runKeeper(opts: KeeperOptions = {}): Promise<KeeperSummary> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const c = client();
  const account = solverAccount(opts.profile ?? "a");
  await assertBare(c, account.address);
  const r = record();
  const house = r.auctionHouse;
  const abi = houseAbi();
  const read = <T>(address: Address, a: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
    withRetry(() => c.readContract({address, abi: a, functionName, args, blockNumber}) as Promise<T>);

  const tokens: {symbol: string; token: Address}[] = [];
  for (const t of tokenList()) {
    if (await read<boolean>(house, abi, "auctionTokenAllowed", [t.token])) tokens.push(t);
  }
  if (tokens.length === 0) throw new Error("AuctionHouse allows no token, so there is nothing to keep. setAuctionTokenAllowed is Wangsit's, through the timelock");

  const [quote, quoteUnit, bond] = await Promise.all([
    read<Address>(house, abi, "quote"),
    read<bigint>(house, abi, "quoteUnit"),
    read<bigint>(house, abi, "bond"),
  ]);
  const allowance = await read<bigint>(quote, erc20Abi as Abi, "allowance", [account.address, house]);
  if (allowance < bond) {
    log(`approving ${bond * 4n} quote units to AuctionHouse for cross bonds`);
    await sendAndWait(c, account, quote, encodeFunctionData({abi: erc20Abi, functionName: "approve", args: [house, bond * 4n]}));
  }

  const summary: KeeperSummary = {blocks: 0, sent: {}, reverted: {}, released: []};
  const refused = new Set<string>();
  const released = new Set<bigint>();
  const lastWhyNot = new Map<bigint, string>();
  // Once per second of chain time rather than once per block. Every keeper
  // transaction is a block of its own, so per block would feed itself, and
  // with 100 ms blocks on mainnet it would be ten transactions a second that
  // say the same thing.
  const publishedAt = new Map<bigint, bigint>();
  const publish = async (id: bigint, T: bigint) => {
    if (publishedAt.get(id) === T) return;
    if ((await act(id, "publishIndicative", [id])) === "sent") publishedAt.set(id, T);
  };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  log(`keeper ${account.address} on AuctionHouse ${house}, tokens ${tokens.map((t) => t.symbol).join(" ")}, bond ${bond}`);

  /**
   * Asks the chain first. A revert that only means too early is a wait. Any
   * other revert is final for this auction and action, and so is one on chain.
   */
  async function act(id: bigint, action: string, args: readonly unknown[]): Promise<"sent" | "wait" | "refused"> {
    const key = `${id}:${action}`;
    if (refused.has(key)) return "refused";
    const data = encodeFunctionData({abi, functionName: action, args});
    try {
      await c.call({account: account.address, to: house, data});
    } catch (error) {
      const name = revertName(error, houseAbi()) ?? (error as Error).message.split("\n")[0]!;
      if (WAIT.test(name)) return "wait";
      refused.add(key);
      bump(summary.reverted, action);
      log(`auction ${id} ${action} refused in simulation, ${name}`);
      return "refused";
    }
    const outcome = await sendAndWait(c, account, house, data);
    if (outcome.ok) {
      bump(summary.sent, action);
      log(`auction ${id} ${action} ${outcome.tx}`);
      return "sent";
    }
    refused.add(key);
    bump(summary.reverted, action);
    log(`auction ${id} ${action} reverted on chain, ${outcome.reason}`);
    return "refused";
  }

  async function reference(id: bigint, token: Address, kind: number, crossAt: bigint, extensions: number): Promise<{ref: bigint; rooExcluded: boolean}> {
    // _reference runs at the first extend or submitCross after referenceAt and
    // is final after that. Before it, the contract will take the reference in
    // the same block as the cross, so the keeper computes it the same way now.
    if (extensions > 0) {
      const [refPrice] = await read<[bigint, bigint, bigint, bigint, number, Address]>(house, abi, "auctionResult", [id]);
      if (kind === KIND_CLOSE) return {ref: refPrice, rooExcluded: false};
      const [, available] = await read<[bigint, boolean]>(r.oracle, oracleAbi(), "openReference", [token, Number(crossAt / 86_400n)]);
      return {ref: refPrice, rooExcluded: !available};
    }
    if (kind === KIND_OPEN) {
      const [openRef, available] = await read<[bigint, boolean]>(r.oracle, oracleAbi(), "openReference", [token, Number(crossAt / 86_400n)]);
      if (available) return {ref: (openRef * quoteUnit) / 10n ** 18n, rooExcluded: false};
      const [price] = await read<[bigint, bigint, boolean]>(r.oracle, oracleAbi(), "refPrice", [token]);
      return {ref: (price * quoteUnit) / 10n ** 18n, rooExcluded: true};
    }
    const [price] = await read<[bigint, bigint, boolean]>(r.oracle, oracleAbi(), "refPrice", [token]);
    return {ref: (price * quoteUnit) / 10n ** 18n, rooExcluded: false};
  }

  async function book(id: bigint): Promise<BookEntry[]> {
    const length = await read<bigint>(house, abi, "bookLength", [id]);
    const out: BookEntry[] = [];
    for (let i = 0n; i < length; i += 1n) {
      const hash = await read<Hex>(house, abi, "bookAt", [id, i]);
      const c_ = await read<{owner: Address; buy: boolean; escrowed: boolean; cancelled: boolean; kind: number; maxDevFromRefBps: number; sellAmount: bigint; limitPrice: bigint; filledSell: bigint}>(house, abi, "commitment", [hash]);
      out.push({index: Number(i), owner: c_.owner, buy: c_.buy, escrowed: c_.escrowed, cancelled: c_.cancelled, kind: Number(c_.kind), maxDevFromRefBps: Number(c_.maxDevFromRefBps), sellAmount: c_.sellAmount, limitPrice: c_.limitPrice, filledSell: c_.filledSell});
    }
    return out;
  }

  async function step(id: bigint, T: bigint): Promise<void> {
    const [token, kind, phaseIndex, , collarBps, extensions] = await read<[Address, number, number, number, number, number]>(house, abi, "auctionState", [id]);
    const phase: PhaseName = PHASE[phaseIndex] ?? "NONE";
    if (phase === "NONE" || phase === "EXECUTED" || phase === "ABORTED") return;
    const [freezeAt, crossAt, referenceAt] = await read<[bigint, bigint, bigint]>(house, abi, "auctionTiming", [id]);

    if (T > referenceAt + RELEASE_AFTER && !released.has(id)) {
      released.add(id);
      summary.released.push(`${id} ${phase}`);
      log(`auction ${id} released in ${phase}, past referenceAt ${referenceAt} by more than ${RELEASE_AFTER} seconds`);
      return;
    }
    if (released.has(id)) return;

    if (phase === "DISCLOSURE") {
      if (T >= freezeAt && T < crossAt) {
        await act(id, "freeze", [id]);
      } else if (T < freezeAt) {
        await publish(id, T);
      } else {
        await act(id, "abortAuction", [id]);
      }
      return;
    }

    if (phase === "FROZEN") {
      if (T < referenceAt) {
        await publish(id, T);
        return;
      }
      const {ref, rooExcluded} = await reference(id, token, Number(kind), crossAt, Number(extensions));
      const [preferred] = await read<[bigint, bigint, bigint]>(house, abi, "indicative", [id]);
      const plan = planCross(await book(id), ref, Number(collarBps), rooExcluded, preferred);
      if (plan.ok) {
        const executions = plan.executions.map((x) => ({intentIndex: x.intentIndex, executedSell: x.executedSell, executedBuy: x.executedBuy}));
        if ((await act(id, "submitCross", [id, plan.price, executions])) !== "refused") return;
      } else if (lastWhyNot.get(id) !== plan.reason) {
        lastWhyNot.set(id, plan.reason);
        log(`auction ${id} no cross yet, ${plan.reason}`);
      }
      if ((await act(id, "extend", [id])) === "sent") return;
      await act(id, "abortAuction", [id]);
      return;
    }

    if (phase === "CROSSED") await act(id, "executeCross", [id]);
  }

  async function tick(blockNumber: bigint): Promise<void> {
    const block = await withRetry(() => c.getBlock({blockNumber}));
    const T = block.timestamp;
    const session = await read<number>(r.sessions, sessionAbi(), "sessionAt", [T]);

    // Open today's auction for every allowed token once the session says so.
    // openAuction reverts WrongPhase on one that is already open, and the
    // simulation catches that before anything is sent.
    const kind = session === SESSION.AUCTION_OPEN ? KIND_OPEN : session === SESSION.AUCTION_CLOSE ? KIND_CLOSE : null;
    if (kind !== null) {
      const crossAt = await read<bigint>(r.sessions, sessionAbi(), "nextTransition", [T]);
      for (const t of tokens) {
        const id = await read<bigint>(house, abi, "auctionIdOf", [t.token, ymdOf(crossAt), kind]);
        const phase = id === 0n ? 0 : (await read<[Address, number, number]>(house, abi, "auctionState", [id]))[2];
        if (phase !== 0) continue;
        const key = `${t.token}:${ymdOf(crossAt)}:${kind}`;
        if (refused.has(key)) continue;
        const data = encodeFunctionData({abi, functionName: "openAuction", args: [t.token, kind]});
        try {
          await c.call({account: account.address, to: house, data});
        } catch (error) {
          refused.add(key);
          log(`${t.symbol} openAuction refused in simulation, ${revertName(error, houseAbi()) ?? (error as Error).message.split("\n")[0]}`);
          continue;
        }
        const outcome = await sendAndWait(c, account, house, data);
        if (outcome.ok) {
          bump(summary.sent, "openAuction");
          log(`${t.symbol} ${kind === KIND_OPEN ? "opening" : "closing"} auction opened, cross at ${crossAt}, ${outcome.tx}`);
        } else {
          refused.add(key);
          bump(summary.reverted, "openAuction");
          log(`${t.symbol} openAuction reverted on chain, ${outcome.reason}`);
        }
      }
    }

    // Every auction still alive, found from the chain rather than remembered.
    const count = await read<bigint>(house, abi, "auctionCount");
    for (let id = count; id > 0n && id > count - RESCAN; id -= 1n) {
      try {
        await step(id, T);
      } catch (error) {
        log(`auction ${id} step failed at block ${blockNumber}, ${(error as Error).message.split("\n")[0]}`);
      }
    }
  }

  const startedAt = (await c.getBlock()).timestamp;
  const endAt = opts.durationMinutes === undefined ? null : startedAt + BigInt(Math.round(opts.durationMinutes * 60));
  let last: bigint | null = null;
  let stop = false;
  process.once("SIGINT", () => (stop = true));
  while (!stop && !opts.stopWhen?.()) {
    const n = await withRetry(() => c.getBlockNumber({cacheTime: 0}));
    if (n !== last) {
      last = n;
      summary.blocks += 1;
      try {
        await tick(n);
      } catch (error) {
        log(`block ${n} failed, ${(error as Error).message.split("\n")[0]}`);
      }
      if (endAt !== null && (await c.getBlock({blockNumber: n})).timestamp >= endAt) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return summary;
}

async function sendAndWait(c: PublicClient, account: HDAccount, to: Address, data: Hex): Promise<{ok: true; tx: Hex} | {ok: false; reason: string}> {
  const w = wallet(account);
  let tx: Hex;
  try {
    const gas = await c.estimateGas({account: account.address, to, data});
    const nonce = await c.getTransactionCount({address: account.address, blockTag: "pending"});
    tx = await w.sendTransaction({account, chain: null, to, data, gas: (gas * 6n) / 5n, nonce});
  } catch (error) {
    return {ok: false, reason: revertName(error, houseAbi()) ?? (error as Error).message.split("\n")[0]!};
  }
  const receipt = await c.waitForTransactionReceipt({hash: tx, pollingInterval: 250, timeout: 60_000});
  if (receipt.status === "success") return {ok: true, tx};
  try {
    await c.call({account: account.address, to, data, blockNumber: receipt.blockNumber});
    return {ok: false, reason: `reverted in ${tx}, and the replay on its block passes`};
  } catch (error) {
    return {ok: false, reason: `${revertName(error, houseAbi()) ?? "reverted"} in ${tx}`};
  }
}

export function describeKeeper(s: KeeperSummary): string {
  const list = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  return [`blocks seen        ${s.blocks}`, `sent               ${list(s.sent)}`, `reverted           ${list(s.reverted)}`, `released           ${s.released.join(", ") || "none"}`].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const {values} = parseArgs({options: {duration: {type: "string"}, profile: {type: "string"}}});
  const summary = await runKeeper({durationMinutes: values.duration === undefined ? undefined : Number(values.duration), profile: (values.profile as Profile | undefined) ?? "a"});
  console.log(describeKeeper(summary));
}
