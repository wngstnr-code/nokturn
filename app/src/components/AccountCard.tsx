"use client";

import Link from "next/link";
import {useEffect, useRef, useState} from "react";
import {useDisconnect, useSwitchChain} from "wagmi";
import {Session} from "@shared/types";
import {explorerAddress} from "@/lib/chain";
import {shortAddress} from "@/lib/format";
import type {Network} from "@/lib/network";
import {countdown, type SessionSnapshot} from "./SessionClock";
import type {WalletNetwork} from "./useWalletNetwork";
import {BellArt, ChainArt, HeldArt, MoonArt, Seal, SunArt} from "./art/Art";
import {CheckIcon, CopyIcon, ExternalIcon, PowerIcon} from "./Icons";
import styles from "./AccountCard.module.css";

/*
 * A colour alone says a state is different without saying which. Each group of
 * sessions has its own picture, the same one the session screen opens on, so the
 * card and the screen never draw one hour two ways.
 */
const TONE: Record<Session, {key: string; Art: typeof MoonArt}> = {
  [Session.OPEN]: {key: "open", Art: SunArt},
  [Session.PRE_MARKET]: {key: "open", Art: SunArt},
  [Session.POST_MARKET]: {key: "open", Art: SunArt},
  [Session.AUCTION_OPEN]: {key: "auction", Art: BellArt},
  [Session.AUCTION_CLOSE]: {key: "auction", Art: BellArt},
  [Session.CLOSED_OVERNIGHT]: {key: "closed", Art: MoonArt},
  [Session.CLOSED_WEEKEND]: {key: "closed", Art: MoonArt},
  [Session.HOLIDAY]: {key: "closed", Art: MoonArt},
  [Session.PROTECTIVE]: {key: "protective", Art: HeldArt},
};

type Props = {
  address: `0x${string}`;
  chainId: number | undefined;
  network: Network;
  reading: WalletNetwork;
  snapshot: SessionSnapshot;
  onClose: () => void;
};

export function AccountCard({address, chainId, network, reading, snapshot, onClose}: Props) {
  const {disconnect} = useDisconnect();
  const {switchChain, isPending} = useSwitchChain();
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const wrongChain = chainId !== network.chainId;

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

  return (
    <div className={styles.card} ref={card} role="dialog" aria-label="Your wallet">
      <div className={styles.who}>
        <div className={styles.whoTop}>
          <span className={`${styles.short} chainvalue`}>{shortAddress(address)}</span>
          <div className={styles.addressTools}>
            <button
              type="button"
              className={styles.tool}
              onClick={copy}
              aria-label={copied ? "Copied" : "Copy address"}
            >
              {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
            </button>
            <a
              className={styles.tool}
              href={explorerAddress(address, network.chainId)}
              target="_blank"
              rel="noreferrer"
              aria-label="Open in the explorer"
            >
              <ExternalIcon size={15} />
            </a>
          </div>
        </div>
        <span className={`${styles.address} chainvalue`}>{address}</span>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Network</span>
        {wrongChain ? (
          <button
            type="button"
            className={styles.switch}
            onClick={() => switchChain({chainId: network.chainId as 4663 | 46630})}
            disabled={isPending}
          >
            {isPending ? "Switching" : `Wrong network. Switch to ${network.name.toLowerCase()}`}
          </button>
        ) : (
          <span className={styles.network}>
            <ChainArt size={18} />
            {network.name}
            <span className={`${styles.networkId} chainvalue`}>{network.chainId}</span>
          </span>
        )}
      </div>
      {network.note === null ? null : <p className={styles.networkNote}>{network.note}</p>}
      {/*
        The ids agree and the heads do not. A fork and the chain it came from share
        an id, so this is the only place that difference can be seen before a
        transaction is refused. The wallet's endpoint is the wallet's to change, so
        this says what to change rather than offering a button that cannot do it.
      */}
      {!wrongChain && reading.state === "other" ? (
        <p className={styles.mismatch}>
          Your wallet is reading another network.{" "}
          {reading.walletHead === null ? (
            "It did not say which block it is on."
          ) : (
            <>
              It is at block <span className="chainvalue">{reading.walletHead.toLocaleString("en-US")}</span>{" "}
              and this app reads block{" "}
              <span className="chainvalue">{reading.appHead.toLocaleString("en-US")}</span>.
            </>
          )}{" "}
          Change the RPC your wallet uses for this chain. Nothing will be sent until they match.
        </p>
      ) : null}

      <div className={styles.row}>
        <span className={styles.rowLabel}>Session</span>
        {snapshot === null ? (
          <span className={`${styles.status} ${styles.offline}`}>
            <Seal state="unknown" size={16} />
            Unavailable
          </span>
        ) : (
          <Link
            href="/session"
            className={`${styles.status} ${styles[tone?.key ?? "closed"]}`}
            onClick={onClose}
          >
            {tone === null ? null : <tone.Art size={18} />}
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
