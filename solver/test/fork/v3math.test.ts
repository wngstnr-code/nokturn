// The gate on the TypeScript port. Zero difference against the deployed
// adapter, in amountOut, crossings and steps, and the same error name when
// either refuses. docs/desain-baseline.md 9.5 and rencana-backend.md F15.
//
// Runs on the batch fork, make fork then make deploy, or on mainnet with
// NOKTURN_SOLVER_RPC set to make rpc-proxy.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, test} from "node:test";
import type {Address} from "viem";
import {REPO_ROOT, adapterAbi} from "../../src/abi.ts";
import {client, deploymentRecord, revertName} from "../../src/chain.ts";
import {QuoteError, quoteExactIn} from "../../src/v3math.ts";
import {readPool} from "../../src/v3pool.ts";

const c = client();
// The deployment the node is on, so NOKTURN_SOLVER_RPC at mainnet runs the same
// gate against the mainnet adapter and live pools.
const record = (await deploymentRecord(c)).record as unknown as {adapter: Address; usdg: Address};
const chainFile = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "chain.json"), "utf8")) as {tokens: Record<string, {token: Address; pool: Address}>};

const sizes = (from: bigint, to: bigint) => {
  const out: bigint[] = [];
  for (let x = from; x <= to; x = (x * 37n) / 10n + 1n) out.push(x);
  return out;
};
const USDG_SIZES = sizes(1n, 5_000_000_000_000n);
const TOKEN_SIZES = sizes(1n, 50n * 10n ** 21n);

describe("v3math against the deployed quoteWithStats, zero difference", () => {
  for (const [symbol, t] of Object.entries(chainFile.tokens)) {
    test(`${symbol} both directions`, async () => {
      const block = await c.getBlockNumber();
      const {state, token0, reads} = await readPool(c, t.pool, block);
      let compared = 0;
      let refusedBoth = 0;
      for (const [tokenIn, tokenOut, amounts] of [
        [record.usdg, t.token, USDG_SIZES],
        [t.token, record.usdg, TOKEN_SIZES],
      ] as const) {
        for (const amount of amounts) {
          let chain: {out: bigint; crossings: number; steps: number} | {error: string};
          try {
            const [out, crossings, steps] = (await c.readContract({address: record.adapter, abi: adapterAbi(), functionName: "quoteWithStats", args: [tokenIn, tokenOut, amount], blockNumber: block})) as [bigint, number, number];
            chain = {out, crossings: Number(crossings), steps: Number(steps)};
          } catch (error) {
            chain = {error: (revertName(error) ?? "not a revert").split("(")[0]!};
          }
          let port: {out: bigint; crossings: number; steps: number} | {error: string};
          try {
            const q = await quoteExactIn(state, tokenIn.toLowerCase() === token0.toLowerCase(), amount, reads);
            port = {out: q.amountOut, crossings: q.crossings, steps: q.steps};
          } catch (error) {
            port = {error: error instanceof QuoteError ? error.errorName : String(error)};
          }
          const label = `${symbol} ${tokenIn === record.usdg ? "USDG in" : "token in"} ${amount} at block ${block}`;
          if ("error" in chain || "error" in port) {
            // A refusal from TickMath or SqrtPriceMath comes back without a name
            // the adapter ABI knows, so only the adapter's own names are compared.
            const chainName = "error" in chain ? chain.error : "none";
            const portName = "error" in port ? port.error : "none";
            if ("error" in chain && "error" in port && !["LiquidityExhausted", "TooManyTickCrossings"].includes(chainName)) refusedBoth += 1;
            else assert.equal(portName, chainName, label);
            continue;
          }
          assert.deepEqual(port, chain, label);
          compared += 1;
        }
      }
      assert.ok(compared >= 20, `${symbol}: only ${compared} sizes quoted on both sides, ${refusedBoth} refused by both`);
    });
  }
});
