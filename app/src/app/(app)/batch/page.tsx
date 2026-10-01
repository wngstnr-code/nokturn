import Link from "next/link";
import {BatchArt} from "@/components/art/Art";
import {OwlState} from "@/components/ui/OwlState";
import {explorerTx} from "@/lib/chain";
import {listBatches} from "@/lib/coordinator/client";
import type {BatchSummary} from "@/lib/coordinator/types";
import {scanBatches, SCAN_SPAN, type BatchRow, type BatchScan} from "@/lib/batches";
import {SESSION_NAMES} from "@/lib/session";
import {sessionLabel, shortAddress, units} from "@/lib/format";
import {active} from "@/lib/network";
import type {Session} from "@shared/types";
import styles from "./page.module.css";

export const metadata = {title: "Batches"};

export const dynamic = "force-dynamic";

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
      <div className={styles.lead}>
        <span className={styles.rowMark} aria-hidden="true">
          <BatchArt size={30} />
        </span>
        <div className={styles.cell}>
          Batch
          <strong className="chainvalue">#{batch.batchId}</strong>
        </div>
      </div>
      <div className={styles.cell}>
        {sessionLabel(batch.sessionName)}
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
function TailRow({row, chainId}: {row: BatchRow; chainId: number}) {
  return (
    <div className={styles.row}>
      <div className={styles.lead}>
        <span className={styles.rowMark} aria-hidden="true">
          <BatchArt size={30} />
        </span>
        <div className={styles.cell}>
          Batch
          <strong>
            <Link className="chainvalue" href={`/batch/${row.batchId.toString()}`}>
              #{row.batchId.toString()}
            </Link>
          </strong>
        </div>
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
            href={explorerTx(row.transactionHash, chainId)}
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
    <OwlState
      mood={scan.error === null ? "waiting" : "asleep"}
      title={scan.error === null ? "No batch closed in the last ten seconds" : "The log scan did not run"}
      detail={
        scan.error ??
        `scanned blocks ${scan.fromBlock.toString()} to ${scan.toBlock.toString()} on chain ${scan.chainId}`
      }
    >
      Without an indexer this screen reads Settlement logs straight from the chain, {SCAN_SPAN.toString()}{" "}
      blocks at a time. That is a live tail rather than a history.
    </OwlState>
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
          <OwlState mood="waiting" title="No batch has closed yet">
            The indexer is answering and has nothing to show, which is a different thing from not
            being able to look.
          </OwlState>
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
    const now = await active();
    scan = await scanBatches(now.network.chainId, now.contracts.settlement);
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
        <OwlState mood="asleep" title="The chain did not answer" detail={failure}>
          Nothing is shown rather than something invented.
        </OwlState>
      ) : null}

      {scan === null ? null : scan.rows.length === 0 ? (
        <Empty scan={scan} />
      ) : (
        <div className={styles.rows}>
          {scan.rows.map((row) => (
            <TailRow key={`${row.transactionHash}-${row.batchId}`} row={row} chainId={scan.chainId} />
          ))}
        </div>
      )}
    </div>
  );
}
