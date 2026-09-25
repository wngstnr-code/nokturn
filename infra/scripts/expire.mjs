// Calls Settlement.expireBatch for a batch whose winner never finalized, from an
// account that is not the solver, once the finalize deadline has passed.
//
//   node infra/scripts/expire.mjs <batchId> [--from <address>]
//
// Fork only, checked with anvil_nodeInfo, because it sends from an impersonated
// account. The deadline is met by watching blocks until chain time passes
// solveEnd + FINALIZE_DEADLINE, never by sleeping, and a wall clock backstop
// stops the wait if the chain stops mining.

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {encodeFunctionData} from "viem";
import {chain, settlementAbi} from "../../api/src/chain.ts";

const accounts = JSON.parse(readFileSync(new URL("../accounts.json", import.meta.url), "utf8"));
/** Wall clock seconds past the deadline's own distance before the wait gives up. */
const BACKSTOP_SLACK_SECONDS = 120;

async function requireFork(c) {
  try {
    await c.client.request({method: "anvil_nodeInfo", params: []});
  } catch {
    throw new Error("expire.mjs sends from an impersonated account and only runs against an anvil fork, anvil_nodeInfo failed");
  }
}

function untilChainTime(c, target, backstopMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unwatch();
      reject(new Error(`chain time did not pass ${target} within ${backstopMs / 1000}s of wall clock. is the fork mining`));
    }, backstopMs);
    const unwatch = c.client.watchBlocks({
      emitOnBegin: true,
      pollingInterval: 500,
      onBlock: (b) => {
        if (b.timestamp > target) {
          clearTimeout(timer);
          unwatch();
          resolve(b.timestamp);
        }
      },
      onError: (error) => {
        clearTimeout(timer);
        unwatch();
        reject(error);
      },
    });
  });
}

export async function expire(batchId, {from = accounts.users[3], log = console.log} = {}) {
  const c = chain();
  await requireFork(c);
  const settlement = c.deployment.settlement;
  const read = (functionName, args = []) => c.client.readContract({address: settlement, abi: settlementAbi, functionName, args});
  if (await read("finalized", [batchId])) throw new Error(`batch ${batchId} is already finalized`);
  const [hash, , solver] = await read("bestSolution", [batchId]);
  if (/^0x0+$/.test(hash)) throw new Error(`batch ${batchId} has no best solution, so there is nothing to expire`);
  if (solver.toLowerCase() === from.toLowerCase()) throw new Error(`${from} is the winner itself. expire from another account`);

  const [, , solveEnd] = await read("batchWindow", [batchId]);
  const deadline = BigInt(solveEnd) + BigInt(await read("FINALIZE_DEADLINE"));
  const now = (await c.client.getBlock()).timestamp;
  const left = deadline > now ? Number(deadline - now) : 0;
  log(`batch ${batchId} won by ${solver}, finalize deadline at chain time ${deadline}, ${left}s away`);
  await untilChainTime(c, deadline, (left + BACKSTOP_SLACK_SECONDS) * 1000);

  const tx = await c.client.request({method: "eth_sendTransaction", params: [{from, to: settlement, data: encodeFunctionData({abi: settlementAbi, functionName: "expireBatch", args: [batchId]}), gas: "0x2dc6c0"}]});
  const receipt = await c.client.waitForTransactionReceipt({hash: tx, pollingInterval: 250});
  if (receipt.status !== "success") throw new Error(`expireBatch(${batchId}) reverted in ${tx}`);
  log(`expireBatch(${batchId}) from ${from} in ${tx}, block ${receipt.blockNumber}`);
  return {tx, block: receipt.blockNumber, solver};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--from");
  if (!argv[0] || !/^\d+$/.test(argv[0])) {
    console.error("usage: node infra/scripts/expire.mjs <batchId> [--from <address>]");
    process.exit(2);
  }
  expire(BigInt(argv[0]), i >= 0 ? {from: argv[i + 1]} : {}).catch((error) => {
    console.error(`expire failed\n  ${error.message}`);
    process.exitCode = 1;
  });
}
