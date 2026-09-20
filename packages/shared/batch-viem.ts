// A ChainReader backed by viem, kept apart from batch.ts so that importing the
// batch logic or the types does not drag a client in with them.
//
// Every read goes to the chain. There is no clock here on purpose, because the
// laptop clock is the bug this module exists to prevent.

import type {Abi, Address, PublicClient} from "viem";
import type {ChainReader} from "./batch";

const sessionAbi = [
  {
    type: "function",
    name: "sessionAt",
    stateMutability: "view",
    inputs: [{name: "timestamp", type: "uint64"}],
    outputs: [{type: "uint8"}],
  },
  {
    type: "function",
    name: "batchDuration",
    stateMutability: "view",
    inputs: [{name: "session", type: "uint8"}],
    outputs: [{type: "uint32"}],
  },
  {
    type: "function",
    name: "inGuardBand",
    stateMutability: "view",
    inputs: [{name: "timestamp", type: "uint64"}],
    outputs: [{type: "bool"}],
  },
  {
    type: "function",
    name: "nextTransition",
    stateMutability: "view",
    inputs: [{name: "from", type: "uint64"}],
    outputs: [{type: "uint64"}],
  },
] as const satisfies Abi;

export interface ReaderOptions {
  /**
   * Cache session lookups for this many entries. The search asks about the same
   * few timestamps repeatedly while it walks out of a guard band, and every one
   * of those is a network round trip inside a ten second window.
   */
  cacheSize?: number;
}

export function createChainReader(
  client: PublicClient,
  sessionManager: Address,
  options: ReaderOptions = {},
): ChainReader {
  const limit = options.cacheSize ?? 256;
  const sessions = new Map<string, number>();
  const durations = new Map<number, number>();
  const bands = new Map<string, boolean>();

  const remember = <K, V>(map: Map<K, V>, key: K, value: V) => {
    if (map.size >= limit) map.clear();
    map.set(key, value);
    return value;
  };

  // viem infers the argument tuple from the abi, and a generic string keyed
  // helper defeats that, so each read states its own name and arguments.
  const call = <T>(request: {functionName: string; args: readonly unknown[]}) =>
    client.readContract({
      address: sessionManager,
      abi: sessionAbi as Abi,
      functionName: request.functionName,
      args: request.args,
    }) as Promise<T>;

  return {
    async now() {
      const block = await client.getBlock();
      return block.timestamp;
    },

    async sessionAt(timestamp) {
      const key = timestamp.toString();
      const hit = sessions.get(key);
      if (hit !== undefined) return hit;
      return remember(sessions, key, Number(await call<number>({functionName: "sessionAt", args: [timestamp]})));
    },

    async batchDuration(session) {
      const hit = durations.get(session);
      if (hit !== undefined) return hit;
      // Safe to cache for the life of the process. batchDuration is pure in the
      // contract, so the answer for a given session never moves. What must not
      // be cached is which session a timestamp falls in, and that is above.
      return remember(durations, session, Number(await call<number>({functionName: "batchDuration", args: [session]})));
    },

    async inGuardBand(timestamp) {
      const key = timestamp.toString();
      const hit = bands.get(key);
      if (hit !== undefined) return hit;
      return remember(bands, key, await call<boolean>({functionName: "inGuardBand", args: [timestamp]}));
    },

    async nextTransition(from) {
      return call<bigint>({functionName: "nextTransition", args: [from]});
    },
  };
}
