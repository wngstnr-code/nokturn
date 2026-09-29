// Reads what v3math.ts needs from a live pool, pinned to one block, and caches
// each bitmap word and tick so a replay quoting the same pool many times reads
// each slot once.

import type {Address, PublicClient} from "viem";
import {loadAbi} from "./abi.ts";
import type {PoolReads, PoolState} from "./v3math.ts";

const poolAbi = () => loadAbi("IUniswapV3Pool");

export async function readPool(c: PublicClient, pool: Address, blockNumber: bigint): Promise<{state: PoolState; token0: Address; reads: PoolReads}> {
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    c.readContract({address: pool, abi: poolAbi(), functionName, args, blockNumber}) as Promise<T>;
  const [slot0, fee, tickSpacing, liquidity, token0] = await Promise.all([
    read<readonly [bigint, number]>("slot0"),
    read<number>("fee"),
    read<number>("tickSpacing"),
    read<bigint>("liquidity"),
    read<Address>("token0"),
  ]);
  const words = new Map<number, Promise<bigint>>();
  const nets = new Map<number, Promise<bigint>>();
  const reads: PoolReads = {
    tickBitmap: (wordPos) => {
      let hit = words.get(wordPos);
      if (!hit) words.set(wordPos, (hit = read<bigint>("tickBitmap", [wordPos])));
      return hit;
    },
    liquidityNet: (tick) => {
      let hit = nets.get(tick);
      if (!hit) nets.set(tick, (hit = read<readonly [bigint, bigint]>("ticks", [tick]).then((t) => t[1])));
      return hit;
    },
  };
  return {
    state: {pool, sqrtPriceX96: slot0[0], tick: Number(slot0[1]), fee: Number(fee), tickSpacing: Number(tickSpacing), liquidity},
    token0,
    reads,
  };
}
