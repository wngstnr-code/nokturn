"use client";

import {useEffect, useState} from "react";
import {useAccount} from "wagmi";
import {CHAIN_ID_TESTNET} from "@shared/addresses";
import {shortAddress} from "@/lib/format";
import {AccountCard} from "./AccountCard";
import {WalletPicker} from "./WalletPicker";
import {WalletIcon, WarningIcon} from "./Icons";
import type {SessionSnapshot} from "./SessionClock";
import styles from "./ConnectWallet.module.css";

export function ConnectWallet({snapshot}: {snapshot: SessionSnapshot}) {
  const [mounted, setMounted] = useState(false);
  const [picking, setPicking] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const {address, isConnected, chainId, status} = useAccount();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (isConnected) setPicking(false);
  }, [isConnected]);

  /*
   * Only the silent reconnect on load gets a placeholder. A connect the person
   * started themselves keeps the picker mounted, because that is where the
   * waiting state lives.
   */
  if (!mounted || status === "reconnecting") {
    return <span className={styles.settling} aria-label="Reconnecting your wallet" />;
  }

  if (!isConnected || address === undefined) {
    return (
      <>
        <button type="button" className={styles.connect} onClick={() => setPicking(true)}>
          Connect wallet
        </button>
        {picking ? <WalletPicker onClose={() => setPicking(false)} /> : null}
      </>
    );
  }

  const wrongChain = chainId !== CHAIN_ID_TESTNET;

  return (
    <div className={styles.anchor}>
      {wrongChain ? (
        <span className={styles.warning} title="You are on the wrong network">
          <WarningIcon size={18} />
        </span>
      ) : null}
      <button
        type="button"
        className={styles.account}
        onClick={() => setShowCard((open) => !open)}
        aria-expanded={showCard}
      >
        <WalletIcon size={16} />
        <span className="chainvalue">{shortAddress(address)}</span>
      </button>
      {showCard ? (
        <AccountCard
          address={address}
          chainId={chainId}
          snapshot={snapshot}
          onClose={() => setShowCard(false)}
        />
      ) : null}
    </div>
  );
}
