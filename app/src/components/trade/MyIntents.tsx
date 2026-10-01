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
import {ClockArt, Seal, SheetsArt} from "@/components/art/Art";
import {CloseIcon} from "@/components/Icons";
import {Hint} from "@/components/ui/Hint";
import styles from "./MyIntents.module.css";

/* Fast enough to follow a 45 second batch when the socket is refused. */
const POLL_BLIND_MS = 5000;

/* A safety net under the socket, not the way news arrives. */
const POLL_LIVE_MS = 20000;

type Answer = {sent: Sent; status: IntentStatusResponse | null; error: ApiError | null};

type Mark = "waiting" | "batched" | "pass" | "fail" | "unknown";

type Look = {label: string; tone: string | undefined; mark: Mark};

/* Each state has a shape as well as a colour, so a row can be read at a glance. */
const LOOK: Record<string, Look> = {
  pending: {label: "Waiting for a batch", tone: styles.pending, mark: "waiting"},
  batched: {label: "In a batch", tone: styles.batched, mark: "batched"},
  settled: {label: "Settled", tone: styles.settled, mark: "pass"},
  partially_settled: {label: "Partly settled", tone: styles.settled, mark: "pass"},
  expired: {label: "Expired", tone: styles.gone, mark: "unknown"},
  cancelled: {label: "Cancelled", tone: styles.gone, mark: "unknown"},
  rejected: {label: "Refused", tone: styles.bad, mark: "fail"},
};

function StateMark({mark}: {mark: Mark}) {
  if (mark === "waiting") return <ClockArt size={15} />;
  if (mark === "batched") return <SheetsArt size={15} />;
  return <Seal state={mark} size={15} />;
}

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
  const {sent, forget} = useIntents();
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
        <span className={styles.title}>
          Your intents
          <Hint label="What an intent is">
            An intent is a signed instruction, not a transaction. Nothing leaves your wallet until
            a batch clears. This list holds what you sent from this browser over the last day.
          </Hint>
        </span>
        <span className={styles.count}>
          {sent.length === 0 ? "none yet" : `${sent.length} in the last day`}
          {streaming ? <span className={styles.live}>live</span> : null}
        </span>
      </div>

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

            // The coordinator calls an intent pending until its batch stops
            // collecting, even once it knows which batch that is. Waiting for a
            // batch, beside a batch number, reads as a contradiction.
            const placed = status !== null && status.status === "pending" && status.batchId != null;

            const look = placed
              ? {label: "In the open batch", tone: styles.batched, mark: "batched" as Mark}
              : status !== null
                ? (LOOK[status.status] ?? {label: status.status, tone: styles.pending, mark: "waiting" as Mark})
                : forgotten
                  ? {label: "No longer held", tone: styles.gone, mark: "unknown" as Mark}
                  : {label: "Not reachable", tone: styles.bad, mark: "fail" as Mark};

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

            const finished =
              status !== null && ["settled", "partially_settled", "expired", "cancelled", "rejected"].includes(status.status);

            return (
              <div key={entry.hash} className={`${styles.row} ${finished ? styles.done : ""}`}>
                <div className={styles.rowTop}>
                  <span className={`${styles.legMain} chainvalue`}>{sold}</span>
                  <span className={styles.rowActions}>
                    <span className={`${styles.badge} ${look.tone ?? ""}`}>
                      <StateMark mark={look.mark} />
                      {look.label}
                    </span>
                    <button
                      type="button"
                      className={styles.dismiss}
                      title="Remove from this list. The intent itself is not cancelled"
                      aria-label="Remove from this list"
                      onClick={() => forget(entry.hash)}
                    >
                      <CloseIcon size={13} />
                    </button>
                  </span>
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
                {/* The way out is for an intent still waiting. One that has finished has no use for it. */}
                {status === null || finished ? null : <EscapeHatch hatch={status.escapeHatch} />}
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
