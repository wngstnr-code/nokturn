import Link from "next/link";
import {explorerTx} from "@/lib/chain";
import {scanBatches, SCAN_SPAN, type BatchRow, type BatchScan} from "@/lib/batches";
import {SESSION_NAMES} from "@/lib/session";
import {shortAddress, units} from "@/lib/format";
import {CHAIN_ID_TESTNET} from "@shared/addresses";
import type {Session} from "@shared/types";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

const CHAIN = CHAIN_ID_TESTNET;

function Row({row}: {row: BatchRow}) {
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
        This page reads Settlement logs straight from the chain, with no indexer in between. The
        endpoint refuses a range of a thousand blocks, so the window is {SCAN_SPAN.toString()} blocks
        wide, which at this block time is about ten seconds. That is a live tail rather than a
        history, and a history is what the indexer is for.
      </p>
      <p className={`${styles.emptyDetail} chainvalue`}>
        {scan.error ??
          `scanned blocks ${scan.fromBlock.toString()} to ${scan.toBlock.toString()} on chain ${scan.chainId}`}
      </p>
    </div>
  );
}

export default async function BatchesPage() {
  let scan: BatchScan | null = null;
  let failure: string | null = null;

  try {
    scan = await scanBatches(CHAIN);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className={styles.page}>
      {failure !== null ? (
        <div className={styles.failure}>
          <h2>The chain did not answer</h2>
          <p>Nothing is shown rather than something invented. The endpoint returned: {failure}</p>
        </div>
      ) : null}

      {scan === null ? null : (
        <>
          <div className={styles.head}>
            <div>
              <p className={styles.eyebrow}>Batches</p>
              <h1 className={styles.title}>Every batch publishes its baseline</h1>
            </div>
            <p className={styles.window}>
              Scanned window
              <strong className="chainvalue">
                {scan.fromBlock.toString()} to {scan.toBlock.toString()}
              </strong>
            </p>
          </div>

          {scan.rows.length === 0 ? (
            <Empty scan={scan} />
          ) : (
            <div className={styles.rows}>
              {scan.rows.map((row) => (
                <Row key={`${row.transactionHash}-${row.batchId}`} row={row} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
