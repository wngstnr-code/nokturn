"use client";

import {useState} from "react";
import type {TokenInfo} from "@/lib/tokens";
import {shortAddress} from "@/lib/format";
import styles from "./TokenSelect.module.css";

function Caret() {
  return (
    <svg className={styles.caret} viewBox="0 0 12 7" width="12" height="7" aria-hidden="true" focusable="false">
      <path d="M1 1 6 6 11 1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

interface TokenSelectProps {
  token: TokenInfo;
  options?: TokenInfo[];
  onSelect?(token: TokenInfo): void;
}

export function TokenSelect({token, options, onSelect}: TokenSelectProps) {
  const [open, setOpen] = useState(false);
  const selectable = options !== undefined && onSelect !== undefined && options.length > 1;

  return (
    <>
      <button
        type="button"
        className={styles.button}
        disabled={!selectable}
        onClick={() => setOpen(true)}
      >
        <span className={styles.mark} aria-hidden="true">
          {token.symbol.slice(0, 2).toUpperCase()}
        </span>
        <span className={styles.symbol}>{token.symbol}</span>
        {selectable ? <Caret /> : null}
      </button>

      {open && selectable ? (
        <div className={styles.backdrop} role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <div className={styles.sheet} onClick={(event) => event.stopPropagation()}>
            <div className={styles.sheetHead}>
              Select a token
              <button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="Close">
                &times;
              </button>
            </div>
            {options.map((option) => (
              <button
                key={option.address}
                type="button"
                className={styles.option}
                onClick={() => {
                  onSelect(option);
                  setOpen(false);
                }}
              >
                <span className={styles.mark} aria-hidden="true">
                  {option.symbol.slice(0, 2).toUpperCase()}
                </span>
                <span>
                  <span className={styles.optionSymbol}>{option.symbol}</span>
                  <span className={styles.optionName}>{option.name ?? "no name() on this contract"}</span>
                </span>
                <span className={`${styles.optionAddress} chainvalue`}>{shortAddress(option.address)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
