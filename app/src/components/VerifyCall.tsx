"use client";

import {useState} from "react";
import type {VerifiableCall} from "@/lib/coordinator/types";
import styles from "./VerifyCall.module.css";

/*
 * Copied verbatim from the coordinator. A command this app assembled itself
 * would be this app marking its own homework. docs/demo.md section 2.
 */
export function VerifyCall({call}: {call: VerifiableCall}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(call.castCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.describes}>{call.describes}</span>
        <button type="button" className={styles.copy} onClick={copy}>
          {copied ? "Copied" : "Copy verification call"}
        </button>
      </div>
      <code className={`${styles.command} chainvalue`}>{call.castCommand}</code>
      <div className={styles.expected}>
        Returns
        <span className="chainvalue">{call.expected}</span>
        at block
        <span className="chainvalue">{call.blockNumber}</span>
      </div>
    </div>
  );
}
