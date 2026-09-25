"use client";

import {useState} from "react";
import type {Address, Hex} from "@/lib/coordinator/types";
import styles from "./EscapeHatch.module.css";

/*
 * The single mempool is an acknowledged point of centralisation, and this is the
 * way out of it. docs/spek-teknis.md section 9.3. The coordinator publishes the
 * payload for every intent it holds, so a user it refuses to relay can still put
 * the intent on chain themselves and let any solver pick it up.
 */
export function EscapeHatch({hatch}: {hatch: {to: Address; data: Hex; castCommand: string}}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(hatch.castCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <details className={styles.hatch}>
      <summary className={styles.summary}>Publish it yourself</summary>
      <p className={styles.body}>
        This calls Settlement.submitIntentOnchain, which publishes the intent and its signature so
        any solver can pick it up. It executes nothing and it does not need this coordinator.
      </p>
      <code className={`${styles.command} chainvalue`}>{hatch.castCommand}</code>
      <div className={styles.actions}>
        <button type="button" className={styles.copy} onClick={copy}>
          {copied ? "Copied" : "Copy the command"}
        </button>
        <span className={`${styles.to} chainvalue`}>to {hatch.to}</span>
      </div>
    </details>
  );
}
