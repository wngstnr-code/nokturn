// A chain that exists only inside the unit tests. Its logs are encoded from the
// real ABIs in packages/shared/abi, so the decoder under test meets exactly the
// bytes the contracts emit. Nothing here reaches the API or any screen.

import {encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Abi, type AbiEvent, type Hex, type Log, type PublicClient} from "viem";
import {loadAbi} from "../../src/abi.ts";
import type {Deployment} from "../../src/ingest.ts";

export const ADDR = {
  settlement: "0x00000000000000000000000000000000000000a1",
  sessions: "0x00000000000000000000000000000000000000a2",
  oracle: "0x00000000000000000000000000000000000000a3",
  solvers: "0x00000000000000000000000000000000000000a4",
  auctionHouse: "0x00000000000000000000000000000000000000a5",
  mandates: "0x00000000000000000000000000000000000000a6",
} as const;

export const DEPLOYMENT: Deployment = {
  chainId: 4663,
  settlement: ADDR.settlement,
  contracts: new Map(Object.entries(ADDR).map(([k, v]) => [v, k as never])),
  fromBlock: 101n,
};

export function encodeLog(contract: string, eventName: string, args: Record<string, unknown>): {topics: Hex[]; data: Hex} {
  const abi = loadAbi(contract) as Abi;
  const event = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent | undefined;
  if (!event) throw new Error(`${contract} has no event ${eventName}`);
  const topics = encodeEventTopics({abi: [event], eventName, args: args as never}) as Hex[];
  const body = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(body, body.map((i) => args[i.name!]) as never);
  return {topics, data};
}

interface Placed {
  address: string;
  topics: Hex[];
  data: Hex;
  txHash: Hex;
  logIndex: number;
}

export class FakeChain {
  private salt = 0;
  private hashes = new Map<bigint, Hex>();
  private logsAt = new Map<bigint, Placed[]>();
  head = 100n;

  constructor() {
    for (let n = 0n; n <= this.head; n += 1n) this.hashes.set(n, this.hashFor(n));
  }

  private hashFor(n: bigint): Hex {
    return keccak256(toHex(`block ${n} salt ${this.salt}`));
  }

  mine(count = 1): bigint {
    for (let i = 0; i < count; i += 1) {
      this.head += 1n;
      this.hashes.set(this.head, this.hashFor(this.head));
    }
    return this.head;
  }

  /** Mines a block carrying these events, one transaction each. */
  emit(events: {contract: string; address: string; event: string; args: Record<string, unknown>}[]): bigint {
    const n = this.mine();
    this.logsAt.set(
      n,
      events.map((e, i) => ({address: e.address, ...encodeLog(e.contract, e.event, e.args), txHash: keccak256(toHex(`tx ${n} ${i} ${this.salt}`)), logIndex: i})),
    );
    return n;
  }

  /** Throws away every block above n, the way evm_revert does, with new hashes from then on. */
  revertTo(n: bigint): void {
    this.salt += 1;
    for (const k of [...this.hashes.keys()]) if (k > n) this.hashes.delete(k);
    for (const k of [...this.logsAt.keys()]) if (k > n) this.logsAt.delete(k);
    this.head = n;
  }

  client(): PublicClient {
    const self = this;
    return {
      async getBlockNumber() {
        return self.head;
      },
      async getBlock({blockNumber}: {blockNumber: bigint}) {
        const hash = self.hashes.get(blockNumber);
        if (!hash) throw new Error(`no block ${blockNumber}`);
        return {number: blockNumber, hash, parentHash: self.hashes.get(blockNumber - 1n) ?? `0x${"0".repeat(64)}`, timestamp: 1_789_000_000n + blockNumber};
      },
      async getLogs({fromBlock, toBlock}: {fromBlock: bigint; toBlock: bigint}) {
        const out: Log[] = [];
        for (let n = fromBlock; n <= toBlock; n += 1n) {
          for (const p of self.logsAt.get(n) ?? []) {
            out.push({address: p.address as Hex, topics: p.topics as never, data: p.data, blockNumber: n, blockHash: self.hashes.get(n)!, transactionHash: p.txHash, logIndex: p.logIndex, transactionIndex: 0, removed: false} as Log);
          }
        }
        return out;
      },
      async getTransaction() {
        return {input: "0x"};
      },
    } as unknown as PublicClient;
  }
}
