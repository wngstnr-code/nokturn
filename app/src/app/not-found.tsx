import Link from "next/link";
import {AppChrome} from "@/components/AppChrome";
import styles from "./message.module.css";

export default function NotFound() {
  return (
    <AppChrome>
      <div className={styles.page}>
        <section className={styles.card}>
          <p className={styles.eyebrow}>404</p>
          <h1 className={styles.title}>There is nothing at this address</h1>
          <p className={styles.body}>
            A batch id has to be a decimal number and an intent hash has to be sixty six characters.
            Anything else reaches here rather than being guessed at.
          </p>
          <div className={styles.links}>
            <Link href="/trade">Trade</Link>
            <Link href="/batch">Batches</Link>
            <Link href="/session">Session</Link>
          </div>
        </section>
      </div>
    </AppChrome>
  );
}
