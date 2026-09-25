"use client";

import Link from "next/link";
import {useCallback, useEffect, useRef, useState} from "react";
import {formatUnits} from "viem";
import {useAccount} from "wagmi";
import {intentStatus} from "@/lib/coordinator/client";
import {watchBatches} from "@/lib/coordinator/stream";
import type {ApiError, IntentStatusResponse} from "@/lib/coordinator/types";
import type {TokenInfo} from "@/lib/tokens";
import {EscapeHatch} from "./EscapeHatch";
import {useIntents, type Sent} from "./IntentsProvider";
import styles from "./MyIntents.module.css";

/* Fast enough to follow a 45 second batch when the socket is refused. */
const POLL_BLIND_MS = 5000;

/* A safety net under the socket, not the way news arrives. */
const POLL_LIVE_MS = 20000;

type Answer = {sent: Sent; status: IntentStatusResponse | null; error: ApiError | null};

type Look = {label: string; tone: string | undefined};

const LOOK: Record<string, Look> = {
  pending: {label: "Waiting for a batch", tone: styles.pending},
  batched: {label: "In a batch", tone: styles.batched},
  settled: {label: "Settled", tone: styles.settled},
  partially_settled: {label: "Partly settled", tone: styles.settled},
  expired: {label: "Expired", tone: styles.gone},
  cancelled: {label: "Cancelled", tone: styles.gone},
  rejected: {label: "Refused", tone: styles.bad},
};

function age(sentAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - sentAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function amount(raw: unknown, token: TokenInfo | undefined): string {
  if (token === undefined || typeof raw !== "string") return "unreadable";
  try {
    const value = Number(formatUnits(BigInt(raw), token.decimals));
    return `${value.toLocaleString("en-US", {maximumFractionDigits: 4})} ${token.symbol}`;
  } catch {
    return "unreadable";
  }
}

/// The list is built from what this tab sent, because nothing on the frozen
/// surface answers "every intent this address has open".
export function MyIntents({reachable, tokens}: {reachable: boolean; tokens: TokenInfo[]}) {
  const {sent} = useIntents();
  const {address} = useAccount();
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    if (sent.length === 0) {
      setAnswers([]);
      return;
    }
    const next = await Promise.all(
      sent.map(async (entry): Promise<Answer> => {
        const result = await intentStatus(entry.hash);
        return result.ok
          ? {sent: entry, status: result.value, error: null}
          : {sent: entry, status: null, error: result.error};
      }),
    );
    if (alive.current) setAnswers(next);
  }, [sent]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), streaming ? POLL_LIVE_MS : POLL_BLIND_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh, streaming]);

  // The socket says a batch moved. What moved is then read back, because the
  // announcement carries a hash and not a status.
  useEffect(() => {
    return watchBatches(address, () => void refresh(), (state) => setStreaming(state.live));
  }, [address, refresh]);

  const bySymbol = new Map(tokens.map((token) => [token.address.toLowerCase(), token]));

  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <span className={styles.title}>Your intents</span>
        <span className={styles.count}>
          {sent.length === 0 ? "none yet" : `${sent.length} in the last day`}
          {streaming ? <span className={styles.live}>live</span> : null}
        </span>
      </div>

      <p className={styles.scope}>
        An intent is a signed instruction, not a transaction. Nothing leaves your wallet until a
        batch clears. This list holds what you sent from this browser over the last day.
      </p>

      {answers.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>
            {reachable ? "No intents yet" : "The intent mempool is not answering"}
          </p>
          <p className={styles.emptyBody}>
            {reachable
              ? "Sign one and it appears here with the batch it lands in."
              : "Signing still works, because a signed intent is a message rather than a transaction. Submitting it does not, and nothing is shown here that did not come back from the coordinator."}
          </p>
        </div>
      ) : (
        <div className={styles.rows}>
          {answers.map(({sent: entry, status, error}) => {
            const forgotten = status === null && error?.message.startsWith("no intent known") === true;

            const look =
              status !== null
                ? (LOOK[status.status] ?? {label: status.status, tone: styles.pending})
                : forgotten
                  ? {label: "No longer held", tone: styles.gone}
                  : {label: "Not reachable", tone: styles.bad};

            const payload = status?.intent as Record<string, unknown> | undefined;
            const sellToken = bySymbol.get(String(payload?.sellToken ?? "").toLowerCase());
            const buyToken = bySymbol.get(String(payload?.buyToken ?? "").toLowerCase());

            // What this tab recorded is the fallback, so a restarted coordinator
            // does not make a row disappear as though it never happened.
            const sold =
              status === null ? entry.sold : amount(payload?.sellAmount, sellToken);

            const line =
              status === null
                ? forgotten
                  ? `for ${entry.buySymbol}. The coordinator restarted and no longer holds it`
                  : `for ${entry.buySymbol}. Its status cannot be read right now`
                : status.rejection !== null
                  ? status.rejection.message
                  : status.fill !== null
                    ? `filled for ${amount((status.fill as {executedBuy?: string}).executedBuy, buyToken)}`
                    : status.status === "expired"
                      ? "the window closed before a batch opened"
                      : `for ${buyToken?.symbol ?? "the quote token"} at the clearing price`;

            return (
              <div key={entry.hash} className={styles.row}>
                <div className={styles.rowTop}>
                  <span className={`${styles.legMain} chainvalue`}>{sold}</span>
                  <span className={`${styles.badge} ${look.tone ?? ""}`}>{look.label}</span>
                </div>
                <div className={styles.rowBottom}>
                  <span className={styles.legSub}>{line}</span>
                  <span className={`${styles.meta} chainvalue`}>
                    {age(entry.sentAt, now)}
                    {status?.batchId == null ? (
                      " · no batch"
                    ) : (
                      <>
                        {" · "}
                        <Link href={`/batch/${status.batchId}`}>batch {status.batchId}</Link>
                      </>
                    )}
                  </span>
                </div>
                {status === null ? null : <EscapeHatch hatch={status.escapeHatch} />}
              </div>
            );
          })}

          <p className={styles.caveat}>
            This is what you sent from this browser, not a full history. The coordinator keeps its
            mempool in memory, so a restart clears it and the escape hatch is the way round that.
          </p>
        </div>
      )}
    </section>
  );
}
