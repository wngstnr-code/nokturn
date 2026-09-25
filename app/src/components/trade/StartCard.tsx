"use client";

import {useState} from "react";
import {WalletPicker} from "@/components/WalletPicker";
import type {TokenInfo} from "@/lib/tokens";
import styles from "./StartCard.module.css";

/*
 * What a first visit sees. Geometry follows the unlock screen in the reference,
 * which puts a headline beside a small illustration and a single wide action
 * under it.
 *
 * The circles are the tokens this deployment actually admits, read from the
 * allowlist rather than drawn, so the panel says something true rather than
 * filling space.
 */
export function StartCard({bases}: {bases: TokenInfo[]}) {
  const [picking, setPicking] = useState(false);

  return (
    <>
      <div className={styles.container}>
        <div className={styles.content}>
          <h2 className={styles.title}>One price for everyone in the batch</h2>
          <h3 className={styles.subtitle}>
            Sign what you want. Nothing leaves your wallet until a batch clears.
          </h3>
        </div>
        <div className={styles.marks} aria-hidden="true">
          {bases.slice(0, 4).map((token) => (
            <span key={token.address} className={styles.mark}>
              {token.symbol.slice(0, 2).toUpperCase()}
            </span>
          ))}
        </div>
      </div>

      <button type="button" className={styles.action} onClick={() => setPicking(true)}>
        Get started
      </button>

      {picking ? <WalletPicker onClose={() => setPicking(false)} /> : null}
    </>
  );
}
