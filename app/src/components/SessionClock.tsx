"use client";

import Link from "next/link";
import {useEffect, useState} from "react";
import {Session} from "@shared/types";
import styles from "./SessionClock.module.css";

export type SessionSnapshot = {
  session: Session;
  name: string;
  nextTransition: number;
  readAt: number;
  chainId: number;
} | null;

const TONE: Record<Session, string> = {
  [Session.OPEN]: "open",
  [Session.PRE_MARKET]: "open",
  [Session.POST_MARKET]: "open",
  [Session.AUCTION_OPEN]: "auction",
  [Session.AUCTION_CLOSE]: "auction",
  [Session.CLOSED_OVERNIGHT]: "closed",
  [Session.CLOSED_WEEKEND]: "closed",
  [Session.HOLIDAY]: "closed",
  [Session.PROTECTIVE]: "protective",
};

export function countdown(seconds: number): string {
  if (seconds <= 0) return "due";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function SessionClock({snapshot}: {snapshot: SessionSnapshot}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (snapshot === null) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [snapshot]);

  if (snapshot === null) {
    return (
      <span className={styles.pill}>
        <span className={`${styles.dot} ${styles.offline}`} aria-hidden="true" />
        Session unavailable
      </span>
    );
  }

  const remaining = snapshot.nextTransition - snapshot.readAt - elapsed;
  const tone = TONE[snapshot.session] ?? "closed";

  return (
    <Link href="/session" className={styles.pill}>
      <span className={`${styles.dot} ${styles[tone]}`} aria-hidden="true" />
      <span className={styles.name}>{snapshot.name}</span>
      <span className={styles.countdown}>{countdown(remaining)}</span>
    </Link>
  );
}
