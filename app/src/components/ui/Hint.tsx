"use client";

import {useEffect, useId, useRef, useState, type ReactNode} from "react";
import {InfoIcon} from "@/components/Icons";
import styles from "./Hint.module.css";

/*
 * The long explanation, one tap away rather than in the reader's path. Nothing a
 * screen has to say is dropped by this, it only stops every reader paying for the
 * sentence a few of them need. Opens on hover, on focus and on tap, and closes on
 * Escape, so it works without a pointer.
 */
export function Hint({label, children}: {label: string; children: ReactNode}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <span
      className={styles.root}
      ref={root}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((shown) => !shown)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <InfoIcon size={14} />
      </button>
      {open ? (
        <span className={styles.bubble} role="tooltip" id={id}>
          {children}
        </span>
      ) : null}
    </span>
  );
}
