// POST /v1/faucet
//
// The only route that signs. It exists because a visitor to the public testnet
// arrives with no gas and no test tokens, and the mints are open but cost gas
// the visitor does not have. It runs on 46630 only, with a key of its own that
// holds nothing but testnet ETH, and every token it hands out is a fixture
// anyone can mint.
//
// Amounts are a top up, not a grant. An address that already holds the target
// is sent nothing, so repeating the call costs the faucet nothing either. What
// limits a farm of fresh addresses is the per IP window.

import type {FastifyInstance} from "fastify";
import {createWalletClient, getAddress, http, isAddress, parseAbi, parseEther, parseUnits, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import type {FaucetRequest, FaucetResponse} from "../../../packages/shared/api-types.ts";
import {erc20Abi} from "../abi.ts";
import {chain} from "../chain.ts";
import {CHAIN_ID_TESTNET, env} from "../config.ts";
import {badRequest, fail} from "../errors.ts";
import {provenance, recentStamp} from "../provenance.ts";

const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

const HOUR = 3600;
const PER_ADDRESS = 3;
const PER_IP = 10;

export function shortfall(held: bigint, target: bigint): bigint {
  return held >= target ? 0n : target - held;
}

/** At most `limit` takes per key in any `windowSeconds`. */
export class Window {
  private seen = new Map<string, number[]>();
  limit: number;
  windowSeconds: number;

  constructor(limit: number, windowSeconds: number) {
    this.limit = limit;
    this.windowSeconds = windowSeconds;
  }

  /** Zero when taken, otherwise the seconds until the oldest take expires. */
  take(key: string, now: number): number {
    const recent = (this.seen.get(key) ?? []).filter((t) => t > now - this.windowSeconds);
    if (recent.length >= this.limit) {
      this.seen.set(key, recent);
      return Math.max(1, Math.ceil(recent[0]! + this.windowSeconds - now));
    }
    recent.push(now);
    this.seen.set(key, recent);
    return 0;
  }
}

/**
 * The client address behind Railway's proxy. The proxy appends the address it
 * saw, so the last entry is the one a caller cannot forge.
 */
export function clientIp(forwarded: string | string[] | undefined, fallback: string): string {
  const header = Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "");
  const last = header.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last ?? fallback;
}

const byAddress = new Window(PER_ADDRESS, HOUR);
const byIp = new Window(PER_IP, HOUR);

// One request at a time, so two of them never pick the same nonce.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

export function faucetRoutes(app: FastifyInstance) {
  app.post<{Body: FaucetRequest | undefined}>("/v1/faucet", async (request): Promise<FaucetResponse> => {
    const c = chain();
    if (c.chainId !== CHAIN_ID_TESTNET || !/^0x[0-9a-fA-F]{64}$/.test(env.faucet.key)) {
      throw fail(404, "COORDINATOR_NOT_IMPLEMENTED", "the faucet runs on testnet 46630 only, and only where a faucet key is set");
    }
    const asked = request.body?.address;
    if (typeof asked !== "string" || !isAddress(asked)) {
      throw badRequest("COORDINATOR_INVALID_REQUEST", "body is {address}, a 20 byte hex address", {address: String(asked)});
    }
    const address = getAddress(asked);

    const now = Math.floor(Date.now() / 1000);
    const wait = byIp.take(clientIp(request.headers["x-forwarded-for"], request.ip), now) || byAddress.take(address.toLowerCase(), now);
    if (wait > 0) {
      throw fail(429, "COORDINATOR_RATE_LIMITED", `the faucet allows ${PER_ADDRESS} requests per address and ${PER_IP} per IP each hour`, {retryAfterSeconds: wait});
    }

    const account = privateKeyToAccount(env.faucet.key as Hex);
    const wallet = createWalletClient({account, chain: c.client.chain, transport: http(env.rpc)});

    const assets: {symbol: string; token: Address | null; target: bigint}[] = [
      {symbol: "ETH", token: null, target: parseEther(env.faucet.eth)},
      {symbol: c.quote.symbol, token: c.quote.address, target: parseUnits(env.faucet.quote, c.quote.decimals)},
      ...c.tokens.map((t) => ({symbol: t.symbol, token: t.token, target: parseUnits(env.faucet.stock, t.decimals)})),
    ];

    return serial(async () => {
      const held = await Promise.all(
        assets.map((a) =>
          a.token === null
            ? c.client.getBalance({address})
            : (c.client.readContract({address: a.token, abi: erc20Abi, functionName: "balanceOf", args: [address]}) as Promise<bigint>),
        ),
      );

      const due = assets.map((a, i) => ({...a, held: held[i]!, amount: shortfall(held[i]!, a.target)}));
      const ethDue = due[0]!.amount;
      const own = await c.client.getBalance({address: account.address});
      // Gas for the mints comes out of the same balance, so leave a margin.
      if (own < ethDue + parseEther("0.0001")) {
        throw fail(503, "COORDINATOR_UPSTREAM_DOWN", `the faucet ${account.address} is out of testnet ETH`, {faucet: account.address});
      }

      let nonce = await c.client.getTransactionCount({address: account.address, blockTag: "pending"});
      const sent: FaucetResponse["sent"] = [];
      for (const a of due) {
        if (a.amount === 0n) continue;
        const tx =
          a.token === null
            ? await wallet.sendTransaction({to: address, value: a.amount, nonce: nonce++, chain: null})
            : await wallet.writeContract({address: a.token, abi: mintAbi, functionName: "mint", args: [address, a.amount], nonce: nonce++, chain: null});
        sent.push({symbol: a.symbol, token: a.token, amount: String(a.amount), tx});
      }

      const receipts = await Promise.all(sent.map((s) => c.client.waitForTransactionReceipt({hash: s.tx, timeout: 30_000})));
      const reverted = sent.filter((_, i) => receipts[i]!.status !== "success").map((s) => s.symbol);
      if (reverted.length > 0) {
        throw fail(502, "COORDINATOR_UPSTREAM_DOWN", `faucet transfers reverted for ${reverted.join(", ")}`, {sent: sent.map((s) => s.tx).join(",")});
      }

      request.log.info({to: address, sent: sent.map((s) => s.symbol)}, "faucet");
      return {
        address,
        sent,
        skipped: due.filter((a) => a.amount === 0n).map((a) => ({symbol: a.symbol, token: a.token, held: String(a.held), target: String(a.target)})),
        faucet: account.address,
        provenance: provenance(await recentStamp()),
      };
    });
  });
}
