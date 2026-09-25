"use client";

import {useEffect, useState} from "react";
import {createPortal} from "react-dom";
import {useConnect, type Connector} from "wagmi";
import {CloseIcon, WalletIcon} from "./Icons";
import styles from "./WalletPicker.module.css";

/*
 * wagmi discovers one connector per wallet the browser announces under EIP-6963,
 * alongside the generic injected() fallback we configure. When a wallet announced
 * itself the fallback points at the same provider, so listing both offers the same
 * wallet twice under two names.
 */
function offered(connectors: readonly Connector[]): Connector[] {
  const announced = connectors.filter((connector) => connector.id !== "injected");
  return announced.length > 0 ? announced : [...connectors];
}

export function WalletPicker({onClose}: {onClose: () => void}) {
  const [ready, setReady] = useState(false);
  const {connect, connectors, isPending, variables, error, reset} = useConnect();
  const choices = offered(connectors);
  const pendingOn = isPending ? variables?.connector : undefined;
  const pendingName = pendingOn instanceof Object && "name" in pendingOn ? pendingOn.name : "your wallet";

  useEffect(() => setReady(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /*
   * The header paints a backdrop-filter, which makes it the containing block for
   * anything fixed inside it. Without the portal this overlay hangs off the navbar
   * instead of the viewport.
   */
  if (!ready) return null;

  return createPortal(
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        className={styles.card}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
      >
        <div className={styles.head}>
          <h2 className={styles.title}>{isPending ? "Waiting for your wallet" : "Connect a wallet"}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <CloseIcon size={18} />
          </button>
        </div>

        {isPending ? (
          <div className={styles.waiting}>
            <span className={styles.spinner} aria-hidden="true" />
            <p className={styles.waitingTitle}>Open {pendingName} and approve the connection</p>
            <p className={styles.waitingNote}>
              Nokturn never asks to move your funds. Connecting only lets this page read your balances.
            </p>
          </div>
        ) : choices.length === 0 ? (
          <p className={styles.empty}>
            No wallet is installed in this browser. Install one, then reload this page.
          </p>
        ) : (
          <ul className={styles.list}>
            {choices.map((connector) => (
              <li key={connector.uid}>
                <button
                  type="button"
                  className={styles.choice}
                  onClick={() => connect({connector})}
                >
                  <span className={styles.mark}>
                    {connector.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={connector.icon} alt="" width={28} height={28} />
                    ) : (
                      <WalletIcon size={20} />
                    )}
                  </span>
                  <span className={styles.choiceName}>{connector.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {error !== null && !isPending ? (
          <div className={styles.error}>
            <p>{error.message}</p>
            <button type="button" className={styles.retry} onClick={() => reset()}>
              Try again
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
