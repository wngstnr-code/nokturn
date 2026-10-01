import Link from "next/link";
import {explorerTx} from "@/lib/chain";
import {listBatches} from "@/lib/coordinator/client";
import type {BatchSummary} from "@/lib/coordinator/types";
import {scanBatches, SCAN_SPAN, type BatchRow, type BatchScan} from "@/lib/batches";
import {SESSION_NAMES} from "@/lib/session";
import {shortAddress, units} from "@/lib/format";
import {CHAIN_ID_TESTNET} from "@shared/addresses";
import type {Session} from "@shared/types";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

const CHAIN = CHAIN_ID_TESTNET;

const OUTCOME_LABEL: Record<string, string> = {
  settled: "Settled",
  passthrough: "Passed through",
  expired: "Expired",
  collecting: "Collecting",
  solving: "Solving",
};

function ratio(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed / 100).toFixed(1)}%` : value;
}

/// Served by the indexer, so this reaches back further than one scan window.
function IndexedRow({batch}: {batch: BatchSummary}) {
  const settled = batch.outcome === "settled";

  return (
    <Link className={styles.row} href={`/batch/${batch.batchId}`}>
      <div className={styles.cell}>
        Batch
        <strong className="chainvalue">#{batch.batchId}</strong>
      </div>
      <div className={styles.cell}>
        {batch.sessionName}
        <strong className="chainvalue">
          {batch.intentCount} intents, {batch.participantCount} owners
        </strong>
      </div>
      <div className={styles.cell}>
        Netting
        <strong className="chainvalue">{ratio(batch.nettingRatioBps)}</strong>
      </div>
      <div className={styles.cell}>
        {settled ? "Savings" : "Outcome"}
        <strong className={settled ? "chainvalue" : styles.notSettled}>
          {settled
            ? `${units(BigInt(batch.totalSavingsUsd), 18, 2)} USD`
            : (OUTCOME_LABEL[batch.outcome] ?? batch.outcome)}
        </strong>
      </div>
    </Link>
  );
}

/// The fallback when no coordinator answers. A hundred blocks of logs is a live
/// tail rather than a history, and the screen says so rather than implying more.
function TailRow({row}: {row: BatchRow}) {
  return (
    <div className={styles.row}>
      <div className={styles.cell}>
        Batch
        <strong>
          <Link className="chainvalue" href={`/batch/${row.batchId.toString()}`}>
            #{row.batchId.toString()}
          </Link>
        </strong>
      </div>
      <div className={styles.cell}>
        Intents
        <strong className="chainvalue">{row.intentCount.toString()}</strong>
      </div>
      <div className={styles.cell}>
        {row.kind === "settled" ? "Savings" : "Reason"}
        <strong className={row.kind === "settled" ? "chainvalue" : undefined}>
          {row.kind === "settled" ? `${units(row.totalSavingsUsd, 18, 2)} USD` : row.reason}
        </strong>
        {row.kind === "passthrough" && row.uncollected.length > 0 ? (
          <span className={styles.note}>
            Settlement could not pull{" "}
            {row.uncollected.map((owner) => (
              <span key={owner} className="chainvalue">
                {shortAddress(owner)}{" "}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <div className={styles.cell}>
        {row.kind === "settled" ? SESSION_NAMES[row.session as Session] : "Pass through"}
        <strong>
          <a
            className="chainvalue"
            href={explorerTx(row.transactionHash, CHAIN)}
            target="_blank"
            rel="noreferrer"
          >
            block {row.blockNumber.toString()}
          </a>
        </strong>
      </div>
    </div>
  );
}

function Empty({scan}: {scan: BatchScan}) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>
        {scan.error === null ? "No batch closed in the scanned window" : "The log scan did not run"}
      </p>
      <p className={styles.emptyBody}>
        Without an indexer this page reads Settlement logs straight from the chain. The endpoint
        refuses a range of a thousand blocks, so the window is {SCAN_SPAN.toString()} blocks wide,
        which at this block time is about ten seconds. That is a live tail rather than a history.
      </p>
      <p className={`${styles.emptyDetail} chainvalue`}>
        {scan.error ??
          `scanned blocks ${scan.fromBlock.toString()} to ${scan.toBlock.toString()} on chain ${scan.chainId}`}
      </p>
    </div>
  );
}

export default async function BatchesPage() {
  const indexed = await listBatches();

  if (indexed.ok) {
    const {batches, cursor} = indexed.value;

    return (
      <div className={styles.page}>
        <div className={styles.head}>
          <div>
            <p className={styles.eyebrow}>Batches</p>
            <h1 className={styles.title}>Every batch publishes its baseline</h1>
          </div>
          <p className={styles.window}>
            Source
            <strong>Indexed settlement logs</strong>
          </p>
        </div>

        {batches.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No batch has closed yet</p>
            <p className={styles.emptyBody}>
              The indexer is answering and has nothing to show, which is a different thing from not
              being able to look.
            </p>
          </div>
        ) : (
          <div className={styles.rows}>
            {batches.map((batch) => (
              <IndexedRow key={batch.batchId} batch={batch} />
            ))}
            {cursor === null ? null : (
              <p className={styles.more}>Older batches exist beyond this page</p>
            )}
          </div>
        )}
      </div>
    );
  }

  let scan: BatchScan | null = null;
  let failure: string | null = null;

  try {
    scan = await scanBatches(CHAIN);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <p className={styles.eyebrow}>Batches</p>
          <h1 className={styles.title}>Every batch publishes its baseline</h1>
        </div>
        <p className={styles.window}>
          Source
          <strong>Chain logs, live tail</strong>
          <span className={styles.note}>{indexed.error.code}</span>
        </p>
      </div>

      {failure !== null ? (
        <div className={styles.failure}>
          <h2>The chain did not answer</h2>
          <p>Nothing is shown rather than something invented. The endpoint returned: {failure}</p>
        </div>
      ) : null}

      {scan === null ? null : scan.rows.length === 0 ? (
        <Empty scan={scan} />
      ) : (
        <div className={styles.rows}>
          {scan.rows.map((row) => (
            <TailRow key={`${row.transactionHash}-${row.batchId}`} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
