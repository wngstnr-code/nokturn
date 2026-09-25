import {decodeEventLog, type Address, type Log} from "viem";
import {clientFor} from "./chain";
import {deploymentFor} from "./deployments";
import {settlementAbi} from "./abi";

/// The public endpoint refuses a getLogs range of a thousand blocks and answers a
/// hundred, and blocks here are roughly a tenth of a second apart. A window this
/// narrow is a live tail, not a history. A history needs the indexer.
export const SCAN_SPAN = 100n;

export type SettledBatch = {
  kind: "settled";
  batchId: bigint;
  solver: Address;
  session: number;
  intentCount: bigint;
  nettedVolumeUsd: bigint;
  routedVolumeUsd: bigint;
  totalSavingsUsd: bigint;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
};

export type PassthroughBatch = {
  kind: "passthrough";
  batchId: bigint;
  intentCount: bigint;
  reason: string;
  /// Owners Settlement named when it could not pull their sell leg. Settlement
  /// cannot tell a withdrawn approval from a spent balance and does not try, so
  /// this names who dropped out and says nothing about why.
  uncollected: Address[];
  blockNumber: bigint;
  transactionHash: `0x${string}`;
};

export type BatchRow = SettledBatch | PassthroughBatch;

type Uncollected = {batchId: bigint; owner: Address};

export type BatchScan = {
  chainId: number;
  settlement: Address;
  fromBlock: bigint;
  toBlock: bigint;
  rows: BatchRow[];
  error: string | null;
};

function decodeUncollected(log: Log): Uncollected | null {
  try {
    const event = decodeEventLog({abi: settlementAbi, data: log.data, topics: log.topics}) as unknown as {
      eventName: string;
      args: Record<string, unknown>;
    };
    if (event.eventName !== "IntentCollectionFailed") return null;
    return {batchId: event.args.batchId as bigint, owner: event.args.owner as Address};
  } catch {
    return null;
  }
}

function decode(log: Log): BatchRow | null {
  try {
    const event = decodeEventLog({
      abi: settlementAbi,
      data: log.data,
      topics: log.topics,
    }) as unknown as {eventName: string; args: Record<string, unknown>};

    if (log.blockNumber === null || log.transactionHash === null) return null;

    if (event.eventName === "BatchSettled") {
      const a = event.args;
      return {
        kind: "settled",
        batchId: a.batchId as bigint,
        solver: a.solver as Address,
        session: Number(a.session),
        intentCount: a.intentCount as bigint,
        nettedVolumeUsd: a.nettedVolumeUsd as bigint,
        routedVolumeUsd: a.routedVolumeUsd as bigint,
        totalSavingsUsd: a.totalSavingsUsd as bigint,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      };
    }

    if (event.eventName === "BatchPassthrough") {
      const a = event.args;
      return {
        kind: "passthrough",
        batchId: a.batchId as bigint,
        intentCount: a.intentCount as bigint,
        reason: a.reason as string,
        uncollected: [],
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function scanBatches(chainId: number): Promise<BatchScan> {
  const deployment = deploymentFor(chainId);
  if (deployment === null) throw new Error(`Nokturn is not deployed on chain ${chainId}`);

  const client = clientFor(chainId);
  const toBlock = await client.getBlockNumber();
  const fromBlock = toBlock > SCAN_SPAN ? toBlock - SCAN_SPAN : 0n;

  try {
    const logs = await client.getLogs({address: deployment.settlement, fromBlock, toBlock});
    const uncollected = logs
      .map(decodeUncollected)
      .filter((entry): entry is Uncollected => entry !== null);

    const rows = logs
      .map(decode)
      .filter((row): row is BatchRow => row !== null)
      .map((row) =>
        row.kind === "passthrough"
          ? {
              ...row,
              uncollected: uncollected
                .filter((entry) => entry.batchId === row.batchId)
                .map((entry) => entry.owner),
            }
          : row,
      )
      .sort((a, b) => Number(b.blockNumber - a.blockNumber));

    return {chainId, settlement: deployment.settlement, fromBlock, toBlock, rows, error: null};
  } catch (thrown) {
    return {
      chainId,
      settlement: deployment.settlement,
      fromBlock,
      toBlock,
      rows: [],
      error: thrown instanceof Error ? thrown.message.split("\n")[0] ?? "getLogs failed" : "getLogs failed",
    };
  }
}
