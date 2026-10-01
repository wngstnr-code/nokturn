import type {ReactNode} from "react";
import styles from "./OwlState.module.css";

type Mood = "waiting" | "asleep" | "searching";

/*
 * The owl stands where a screen has nothing to show, and its eyes say which kind
 * of nothing it is. Open and looking means nothing has happened yet. Closed means
 * the chain or the coordinator did not answer. One eye through a lens means the
 * thing asked for is not there. The head is the logo's own outline.
 */
function Owl({mood}: {mood: Mood}) {
  return (
    <svg viewBox="0 0 96 96" width="96" height="96" aria-hidden="true" className={styles.owl}>
      <ellipse cx="48" cy="86" rx="30" ry="4" className={styles.ground} />
      <g transform="translate(16 10)">
        <path
          d="M3 13L19 19.5Q32 16 45 19.5L61 13Q62.5 28 59 40Q53.5 58.5 32 60.5Q10.5 58.5 5 40Q1.5 28 3 13Z"
          className={styles.head}
        />
        {mood === "asleep" ? (
          <>
            <path d="M12 36Q21 43 30 36" className={styles.closed} />
            <path d="M34 36Q43 43 52 36" className={styles.closed} />
          </>
        ) : (
          <>
            <circle cx="21" cy="35" r="11.4" className={styles.socket} />
            <circle cx="43" cy="35" r="11.4" className={styles.socket} />
            <circle cx="21" cy="35" r="6" className={styles.eye} />
            <circle cx="43" cy="35" r="6" className={styles.eye} />
            <circle cx="21" cy="35" r="2.4" className={styles.socket} />
            <circle cx="43" cy="35" r="2.4" className={styles.socket} />
          </>
        )}
        <path d="M28 44H36L32 52Z" className={styles.beak} />
        {mood === "searching" ? (
          <>
            <circle cx="43" cy="35" r="15" className={styles.lens} />
            <path d="M54 46L64 58" className={styles.handle} />
          </>
        ) : null}
        {mood === "asleep" ? (
          <path d="M50 6h8l-8 9h8M61 0h5l-5 6h5" className={styles.snore} />
        ) : null}
      </g>
    </svg>
  );
}

export function OwlState({
  mood,
  title,
  children,
  detail,
}: {
  mood: Mood;
  title: string;
  children?: ReactNode;
  /** What the chain or the coordinator said, word for word. */
  detail?: string | null;
}) {
  return (
    <div className={styles.state}>
      <Owl mood={mood} />
      <div className={styles.words}>
        <p className={styles.title}>{title}</p>
        {children === undefined ? null : <p className={styles.body}>{children}</p>}
        {detail ? <p className={`${styles.detail} chainvalue`}>{detail}</p> : null}
      </div>
    </div>
  );
}
