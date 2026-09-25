"use client";

import Link from "next/link";
import {useEffect, useRef, useState} from "react";
import {useDisconnect, useSwitchChain} from "wagmi";
import {Session} from "@shared/types";
import {CHAIN_ID_TESTNET} from "@shared/addresses";
import {countdown, type SessionSnapshot} from "./SessionClock";
import {
  BoltIcon,
  CheckIcon,
  CopyIcon,
  ExternalIcon,
  GlobeIcon,
  MoonIcon,
  OfflineIcon,
  PowerIcon,
  ShieldIcon,
} from "./Icons";
import styles from "./AccountCard.module.css";

const EXPLORER = "https://robinhood-testnet.cloud.blockscout.com";

/*
 * A colour alone says a state is different without saying which, and the four
 * session groups already read differently to a colourblind eye only by luck. Each
 * tone carries a glyph so the shape carries the meaning too.
 */
const TONE: Record<Session, {key: string; Icon: typeof CheckIcon}> = {
  [Session.OPEN]: {key: "open", Icon: CheckIcon},
  [Session.PRE_MARKET]: {key: "open", Icon: CheckIcon},
  [Session.POST_MARKET]: {key: "open", Icon: CheckIcon},
  [Session.AUCTION_OPEN]: {key: "auction", Icon: BoltIcon},
  [Session.AUCTION_CLOSE]: {key: "auction", Icon: BoltIcon},
  [Session.CLOSED_OVERNIGHT]: {key: "closed", Icon: MoonIcon},
  [Session.CLOSED_WEEKEND]: {key: "closed", Icon: MoonIcon},
  [Session.HOLIDAY]: {key: "closed", Icon: MoonIcon},
  [Session.PROTECTIVE]: {key: "protective", Icon: ShieldIcon},
};

type Props = {
  address: `0x${string}`;
  chainId: number | undefined;
  snapshot: SessionSnapshot;
  onClose: () => void;
};

export function AccountCard({address, chainId, snapshot, onClose}: Props) {
  const {disconnect} = useDisconnect();
  const {switchChain, isPending} = useSwitchChain();
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const wrongChain = chainId !== CHAIN_ID_TESTNET;

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (card.current && !card.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (snapshot === null) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [snapshot]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const tone = snapshot === null ? null : TONE[snapshot.session];
  const StatusIcon = tone?.Icon ?? OfflineIcon;

  return (
    <div className={styles.card} ref={card} role="dialog" aria-label="Your wallet">
      <div className={styles.addressRow}>
        <span className={`${styles.address} chainvalue`}>{address}</span>
        <div className={styles.addressTools}>
          <button type="button" className={styles.tool} onClick={copy} aria-label="Copy address">
            <CopyIcon size={15} />
          </button>
          <a
            className={styles.tool}
            href={`${EXPLORER}/address/${address}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in the explorer"
          >
            <ExternalIcon size={15} />
          </a>
        </div>
      </div>
      <p className={styles.copied} aria-live="polite">
        {copied ? "Copied" : ""}
      </p>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Network</span>
        {wrongChain ? (
          <button
            type="button"
            className={styles.switch}
            onClick={() => switchChain({chainId: CHAIN_ID_TESTNET})}
            disabled={isPending}
          >
            {isPending ? "Switching" : "Wrong network. Switch to testnet"}
          </button>
        ) : (
          <span className={styles.network}>
            <GlobeIcon size={15} />
            Testnet
            <span className={`${styles.networkId} chainvalue`}>46630</span>
          </span>
        )}
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Session</span>
        {snapshot === null ? (
          <span className={`${styles.status} ${styles.offline}`}>
            <StatusIcon size={14} />
            Unavailable
          </span>
        ) : (
          <Link
            href="/session"
            className={`${styles.status} ${styles[tone?.key ?? "closed"]}`}
            onClick={onClose}
          >
            <StatusIcon size={14} />
            {snapshot.name}
            <span className={styles.countdown}>
              {countdown(snapshot.nextTransition - snapshot.readAt - elapsed)}
            </span>
          </Link>
        )}
      </div>

      <button type="button" className={styles.disconnect} onClick={() => disconnect()}>
        <PowerIcon size={15} />
        Disconnect
      </button>
    </div>
  );
}
