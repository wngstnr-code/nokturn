"use client";

import {useState} from "react";
import {CheckIcon, CopyIcon, ExternalIcon} from "@/components/Icons";
import {shortAddress} from "@/lib/format";
import styles from "./AddressChip.module.css";

/*
 * Forty two characters of hex is not something anyone reads, and a wall of them
 * hides the two or three figures a screen is actually about. The chip shows the
 * ends, which is enough to tell two addresses apart, and keeps the whole value one
 * click away for the reader who wants to check it.
 */
export function AddressChip({value, href, label}: {value: string; href?: string; label?: string}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span className={styles.chip} title={value}>
      <span className={`${styles.value} chainvalue`}>{shortAddress(value)}</span>
      <button
        type="button"
        className={styles.tool}
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy ${label ?? "the full value"}`}
      >
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
      {href === undefined ? null : (
        <a
          className={styles.tool}
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${label ?? "this"} in the explorer`}
        >
          <ExternalIcon size={13} />
        </a>
      )}
    </span>
  );
}
