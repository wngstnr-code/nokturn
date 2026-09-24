"use client";

import {useAccount, useConnect, useDisconnect, useSwitchChain} from "wagmi";
import {CHAIN_ID_TESTNET} from "@shared/addresses";
import {shortAddress} from "@/lib/format";
import styles from "./ConnectWallet.module.css";

export function ConnectWallet() {
  const {address, isConnected, chainId} = useAccount();
  const {connect, connectors, isPending} = useConnect();
  const {disconnect} = useDisconnect();
  const {switchChain} = useSwitchChain();

  const injectedConnector = connectors[0];

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
