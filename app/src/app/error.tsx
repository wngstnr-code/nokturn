"use client";

import {useEffect} from "react";
import styles from "./message.module.css";

/*
 * The message is the one thrown, not a friendly replacement for it. Most
 * failures here are a chain read that did not answer, and hiding which one
 * leaves nobody able to act.
 */
export default function Error({error, reset}: {error: Error & {digest?: string}; reset(): void}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className={styles.page}>
      <section className={styles.card}>
        <p className={styles.eyebrow}>Something threw</p>
        <h1 className={styles.title}>This screen could not be built</h1>
        <p className={styles.body}>
          Nothing is shown rather than something invented. What failed is printed below exactly as
          it was raised.
        </p>
        <p className={`${styles.detail} chainvalue`}>
          {error.message}
          {error.digest === undefined ? null : ` (${error.digest})`}
        </p>
        <div className={styles.links}>
          <button type="button" className={styles.retry} onClick={reset}>
            Try again
          </button>
        </div>
      </section>
    </div>
  );
}
