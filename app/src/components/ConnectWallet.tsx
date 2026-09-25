"use client";

import {useEffect, useState} from "react";
import {useAccount, useConnect, useDisconnect, useSwitchChain} from "wagmi";
import {CHAIN_ID_TESTNET} from "@shared/addresses";
import {shortAddress} from "@/lib/format";
import styles from "./ConnectWallet.module.css";

export function ConnectWallet() {
  const [mounted, setMounted] = useState(false);
  const {address, isConnected, chainId, status} = useAccount();
  const {connect, connectors, isPending} = useConnect();
  const {disconnect} = useDisconnect();
  const {switchChain} = useSwitchChain();

  useEffect(() => setMounted(true), []);

  const injectedConnector = connectors[0];
  const settling = !mounted || status === "connecting" || status === "reconnecting";

  if (settling) {
    return <span className={styles.settling} aria-label="Reconnecting your wallet" />;
  }

  if (!isConnected) {
    return (
      <button
        type="button"
        className={styles.connect}
        disabled={isPending || injectedConnector === undefined}
        onClick={() => injectedConnector && connect({connector: injectedConnector})}
      >
        {injectedConnector === undefined ? "No wallet found" : isPending ? "Connecting" : "Connect wallet"}
      </button>
    );
  }

  if (chainId !== CHAIN_ID_TESTNET) {
    return (
      <button
        type="button"
        className={`${styles.connect} ${styles.wrongChain}`}
        onClick={() => switchChain({chainId: CHAIN_ID_TESTNET})}
      >
        Switch to testnet
      </button>
    );
  }

  return (
    <button type="button" className={styles.account} onClick={() => disconnect()}>
      <span className="chainvalue">{address ? shortAddress(address) : ""}</span>
    </button>
  );
}
