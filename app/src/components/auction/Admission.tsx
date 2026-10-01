import type {Network} from "@/lib/network";
import styles from "./Admission.module.css";

/*
 * Said above the book and before any figure, never as a footnote. On a fork the
 * committers are wallets this team holds, since nobody can produce another
 * person's signature, and a reader who learned that after the numbers would be
 * right to distrust all of them. docs/demo.md section 3b, and section 3d for the
 * line about the script, which has to match what is said aloud.
 */
export function Admission({kind}: {kind: Network["kind"]}) {
  if (kind !== "fork") return null;

  return (
    <aside className={styles.admission}>
      <p className={styles.lead}>The participants here are our own demo wallets</p>
      <p className={styles.body}>
        Nobody can sign for somebody else, so a book on a fork cannot be filled by the traders who
        were really there. What the contracts decide is real: the tokens, the feeds, the session
        calendar, the clearing price they search for, and whether the print is issued or withheld.
      </p>
      <p className={styles.body}>
        This cross was run by a script on the fork, with the clock held inside the closing session.
        It was not run by a keeper acting on its own.
      </p>
    </aside>
  );
}
