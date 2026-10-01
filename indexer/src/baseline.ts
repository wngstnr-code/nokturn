// Reads every quoteFromState a receipt will show, right after its batch settles.
//
// The receipt used to ask the chain on every open, at the block the verifier
// read. A fork keeps a few hundred blocks of state and the official mainnet RPC
// about ten minutes, so a receipt answered for a while and then turned into a
// 502. Measured on the fork 1 October 2026, three batches lost theirs inside
// twenty five minutes. Read once here, while the state is still there.

import {BaseError, ContractFunctionRevertedError, type Address, type PublicClient} from "viem";
import {loadAbi} from "./abi.ts";
import type {Queryable} from "./db.ts";
import {baselineCalls, loadFacts} from "./receipt.ts";

function reverted(error: unknown): boolean {
  return error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError;
}

/**
 * For the settled batches closed in from..to. A read the node can no longer
 * answer is skipped and logged, and the receipt falls back to asking the chain.
 * Returns how many answers were stored.
 */
export async function recordBaselines(q: Queryable, c: PublicClient, chainId: number, settlement: string, from: bigint, to: bigint, log: (line: string) => void): Promise<number> {
  const closed = await q.query("SELECT batch_id, block_number FROM batches WHERE deployment = $1 AND outcome = 'settled' AND block_number BETWEEN $2 AND $3", [settlement, String(from), String(to)]);
  const settlementAbi = loadAbi("Settlement");
  const adapterAbi = loadAbi("UniswapV3Adapter");
  let stored = 0;
  for (const b of closed.rows) {
    const facts = await loadFacts(q, settlement, BigInt(b.batch_id));
    const adapters = new Map<bigint, Address>();
    for (const call of baselineCalls(facts)) {
      let adapter: Address;
      let amountOut: bigint | null;
      try {
        if (!adapters.has(call.block)) adapters.set(call.block, (await c.readContract({address: settlement as Address, abi: settlementAbi, functionName: "baselineAdapter", blockNumber: call.block})) as Address);
        adapter = adapters.get(call.block)!;
        try {
          amountOut = (await c.readContract({address: adapter, abi: adapterAbi, functionName: "quoteFromState", args: [call.sellToken, call.buyToken, call.amount], blockNumber: call.block})) as bigint;
        } catch (error) {
          if (!reverted(error)) throw error;
          amountOut = null;
        }
      } catch (error) {
        log(`baseline for batch ${b.batch_id} not stored, ${call.sellToken} to ${call.buyToken} on ${call.amount} at ${call.block}. ${(error as Error).message.split("\n")[0]}`);
        continue;
      }
      const res = await q.query(
        `INSERT INTO baseline_quotes (deployment, batch_id, adapter, sell_token, buy_token, amount, quote_block, amount_out, chain_id, block_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
        [settlement, String(b.batch_id), adapter.toLowerCase(), call.sellToken.toLowerCase(), call.buyToken.toLowerCase(), String(call.amount), String(call.block), amountOut === null ? null : String(amountOut), chainId, String(b.block_number)],
      );
      stored += res.rowCount ?? 0;
    }
  }
  return stored;
}
