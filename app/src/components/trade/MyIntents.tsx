"use client";

import Link from "next/link";
import {useEffect, useState} from "react";
import {intentStatus} from "@/lib/coordinator/client";
import type {ApiError, Hex, IntentStatusResponse} from "@/lib/coordinator/types";
import {shortAddress} from "@/lib/format";
import {useIntents} from "./IntentsProvider";
import styles from "./MyIntents.module.css";

type Row = {hash: Hex; status: IntentStatusResponse | null; error: ApiError | null};

const POLL_MS = 5000;

const TONE: Record<string, string | undefined> = {
  pending: styles.pending,
  batched: styles.batched,
  settled: styles.settled,
  partially_settled: styles.settled,
  expired: styles.gone,
  rejected: styles.bad,
  cancelled: styles.gone,
};

/// The list is built from what this tab sent, because nothing on the frozen
/// surface answers "every intent this address has open".
export function MyIntents({detail, reachable}: {detail: string; reachable: boolean}) {
  const {hashes} = useIntents();
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (hashes.length === 0) {
      setRows([]);
      return;
    }

    let live = true;

    async function refresh() {
      const next = await Promise.all(
        hashes.map(async (hash): Promise<Row> => {
          const result = await intentStatus(hash);
          return result.ok
            ? {hash, status: result.value, error: null}
            : {hash, status: null, error: result.error};
        }),
      );
      if (live) setRows(next);
    }

    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [hashes]);

  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <span className={styles.title}>Your intents</span>
        <span className={styles.count}>
          {hashes.length === 0 ? "none yet" : `${hashes.length} sent from this tab`}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>
            {reachable ? "No intents yet" : "The intent mempool is not reachable"}
          </p>
          <p className={styles.emptyBody}>
            {reachable
              ? "Sign an intent and it appears here with the batch it lands in."
              : "A signed intent is a message, not a transaction, so signing works without this service. Submitting it does not, and nothing is shown here that did not come back from it."}
          </p>
          <p className={`${styles.emptyDetail} chainvalue`}>{detail}</p>
        </div>
      ) : (
        <div className={styles.rows}>
          {rows.map((row) => (
            <div key={row.hash} className={styles.row}>
              <span className={`${styles.hash} chainvalue`}>{shortAddress(row.hash)}</span>

              {row.status === null ? (
                <span className={`${styles.badge} ${styles.bad}`}>
                  {row.error?.code ?? "unreadable"}
                </span>
              ) : (
                <>
                  <span className={`${styles.badge} ${TONE[row.status.status] ?? styles.pending}`}>
                    {row.status.status.replace("_", " ")}
                  </span>
                  {row.status.batchId === null ? (
                    <span className={styles.batch}>no batch</span>
                  ) : (
                    <Link className={`${styles.batch} chainvalue`} href={`/batch/${row.status.batchId}`}>
                      batch {row.status.batchId}
                    </Link>
                  )}
                </>
              )}
            </div>
          ))}

          <p className={styles.caveat}>
            This is what this tab sent, not a full history. The coordinator keeps its mempool in
            memory, so a restart clears it and the escape hatch is the way round that.
          </p>
        </div>
      )}
    </section>
  );
}
