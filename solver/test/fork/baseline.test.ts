// The F15 zero difference gate. The solver's quote against a raw eth_call to
// the same adapter at one pinned block, for every allowlisted token, both
// directions and five sizes.
//
// Both sides are eth_call, so this looks trivial, and it is kept anyway. It is
// what stops someone from quietly swapping the solver's path for a local port of
// the tick math later.

import assert from "node:assert/strict";
import {before, describe, test} from "node:test";
import {decodeErrorResult, decodeFunctionResult, encodeFunctionData, type Address, type Hex, type PublicClient} from "viem";
import {ALLOWLIST_V1, STOCK_TOKENS, USDG} from "../../../packages/shared/addresses.ts";
import {adapterAbi} from "../../src/abi.ts";
import {quote} from "../../src/baseline.ts";
import {client, contracts, settlementAddress} from "../../src/chain.ts";

const QUOTE_SIZES = [1n, 10n, 100n, 1_000n, 10_000n].map((x) => x * 10n ** 6n);
const BASE_SIZES = [1n, 10n, 100n, 1_000n, 10_000n].map((x) => x * 10n ** 16n);

let c: PublicClient;
let adapter: Address;
let block: bigint;

async function raw(tokenIn: Address, tokenOut: Address, amount: bigint): Promise<string> {
  const data = encodeFunctionData({abi: adapterAbi(), functionName: "quoteFromState", args: [tokenIn, tokenOut, amount]});
  try {
    const res = await c.call({to: adapter, data, blockNumber: block});
    return String(decodeFunctionResult({abi: adapterAbi(), functionName: "quoteFromState", data: res.data!}));
  } catch (error) {
    const revert = (error as {walk?: (f: (e: unknown) => boolean) => unknown}).walk?.((e) => typeof (e as {data?: unknown}).data === "string") as {data?: Hex} | undefined;
    if (!revert?.data) throw error;
    const decoded = decodeErrorResult({abi: adapterAbi(), data: revert.data});
    const args = decoded.args?.map((a) => String(a)).join(", ");
    return `error ${args ? `${decoded.errorName}(${args})` : decoded.errorName}`;
  }
}

describe("F15 baseline, zero difference against the adapter", () => {
  before(async () => {
    c = client();
    block = await c.getBlockNumber();
    adapter = (await contracts(c, settlementAddress(), block)).baselineAdapter;
  });

  test("4 tokens, 2 directions, 5 sizes, one pinned block", async () => {
    const rows: string[] = [];
    let compared = 0;
    let quoted = 0;
    for (const symbol of ALLOWLIST_V1) {
      const token = STOCK_TOKENS[symbol] as Address;
      const legs: [Address, Address, bigint[]][] = [
        [USDG as Address, token, QUOTE_SIZES],
        [token, USDG as Address, BASE_SIZES],
      ];
      for (const [tokenIn, tokenOut, sizes] of legs) {
        for (const amount of sizes) {
          const mine = await quote(c, adapter, tokenIn, tokenOut, amount, block);
          const theirs = await raw(tokenIn, tokenOut, amount);
          const got = mine.ok ? String(mine.out) : `error ${mine.error}`;
          compared += 1;
          if (mine.ok) quoted += 1;
          rows.push(`${symbol} ${tokenIn === USDG ? "buy" : "sell"} ${amount} -> ${got}`);
          assert.equal(got, theirs, `${symbol} ${tokenIn} -> ${tokenOut} amount ${amount} at block ${block}`);
        }
      }
    }
    console.log(`block ${block}, adapter ${adapter}, ${compared} compared, ${quoted} quoted, ${compared - quoted} named reverts`);
    for (const r of rows) console.log(`  ${r}`);
    assert.equal(compared, 40);
  });
});
