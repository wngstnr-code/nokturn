import styles from "./loading.module.css";

/*
 * Every screen that reads the chain is dynamic, so the server holds the response
 * until the reads come back. Without this the browser shows the previous page,
 * or nothing, for as long as that takes.
 */
export default function Loading() {
  return (
    <div className={styles.page} role="status" aria-label="Reading the chain">
      <div className={styles.card}>
        <span className={`${styles.bar} ${styles.short}`} />
        <span className={styles.block} />
      </div>
      <div className={styles.card}>
        <span className={`${styles.bar} ${styles.short}`} />
        <span className={styles.block} />
      </div>
    </div>
  );
}
