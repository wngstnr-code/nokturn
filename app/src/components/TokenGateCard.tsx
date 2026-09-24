import {explorerAddress} from "@/lib/chain";
import {bytesLabel, compactSupply, units} from "@/lib/format";
import type {Check, CheckState, TokenReport} from "@/lib/allowlist-gate";
import styles from "./TokenGateCard.module.css";

// Drawn rather than typed. The repo's emoji gate rejects the tick and cross
// glyphs in a .tsx file, and a letter in their place reads as a grade.
const GLYPH: Record<CheckState, string> = {
  pass: "M1.5 6.4 4.4 9.3 10.5 3.2",
  fail: "M2.2 2.2 9.8 9.8 M9.8 2.2 2.2 9.8",
  unknown: "M6 2.6 6 7.2 M6 9.2 6 9.9",
};

const MARK_TONE: Record<CheckState, string | undefined> = {
  pass: styles.markPass,
  fail: styles.markFail,
  unknown: styles.markUnknown,
};

function Mark({state}: {state: CheckState}) {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
      <path
        d={GLYPH[state]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckRow({check}: {check: Check}) {
  return (
    <li className={styles.check}>
      <span className={`${styles.mark} ${MARK_TONE[check.state]}`}>
        <Mark state={check.state} />
      </span>
      <span>
        <span className={styles.checkLabel}>{check.label}</span>
        <div className={`${styles.reading} chainvalue`}>
          <span className={styles.key}>read</span>
          {check.reading}
        </div>
        <div className={`${styles.expected} chainvalue`}>
          <span className={styles.key}>want</span>
          {check.expected}
        </div>
      </span>
    </li>
  );
}

const VERDICT_LABEL = {admitted: "Admitted", rejected: "Rejected", unknown: "Not answered"} as const;

export function TokenGateCard({report}: {report: TokenReport}) {
  const tone =
    report.verdict === "admitted"
      ? ""
      : report.verdict === "rejected"
        ? styles.rejected
        : styles.unknownCard;

  return (
    <article className={`${styles.card} ${tone}`}>
      <div className={styles.head}>
        <div className={styles.identity}>
          <h2 className={styles.symbol}>
            {report.listed ? (
              report.requested
            ) : (
              <span className={styles.quoted}>&ldquo;{report.requested}&rdquo;</span>
            )}
          </h2>
          <p className={styles.name}>{report.name ?? "no name() on this contract"}</p>
        </div>
        <span
          className={`${styles.verdict} ${
            report.verdict === "admitted"
              ? styles.admitted
              : report.verdict === "rejected"
                ? styles.refused
                : styles.unsure
          }`}
        >
          {VERDICT_LABEL[report.verdict]}
        </span>
      </div>

      <div className={styles.address}>
        <span className={`${styles.addressValue} chainvalue`}>{report.address}</span>
        <a href={explorerAddress(report.address)} target="_blank" rel="noreferrer">
          Open in explorer
        </a>
      </div>

      <ul className={styles.checks}>
        {report.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>

      <div className={styles.facts}>
        <span className={styles.fact}>
          Total supply
          <strong className="chainvalue">
            {report.totalSupply === null || report.decimals === null
              ? "unreadable"
              : compactSupply(report.totalSupply, report.decimals)}
          </strong>
        </span>
        <span className={styles.fact}>
          Decimals
          <strong className="chainvalue">{report.decimals ?? "unreadable"}</strong>
        </span>
        <span className={styles.fact}>
          Deployed code
          <strong className="chainvalue">
            {report.codeBytes === null ? "unreadable" : bytesLabel(report.codeBytes)}
          </strong>
        </span>
        {report.totalSupply !== null && report.decimals !== null && report.listed ? (
          <span className={styles.fact}>
            Exact supply
            <strong className="chainvalue">{units(report.totalSupply, report.decimals, 4)}</strong>
          </span>
        ) : null}
      </div>
    </article>
  );
}
