import {Seal} from "@/components/art/Art";
import {AddressChip} from "@/components/ui/AddressChip";
import {Hint} from "@/components/ui/Hint";
import {explorerAddress} from "@/lib/chain";
import {bytesLabel, compactSupply, units} from "@/lib/format";
import type {Check, TokenReport} from "@/lib/allowlist-gate";
import styles from "./TokenGateCard.module.css";
import {TokenMark} from "@/components/TokenMark";

/*
 * A check that passed needs one line. What was read and what was wanted are two
 * long hex strings that agree, so they wait behind the info mark. A check that
 * did not pass shows both, because the difference between them is the finding.
 */
function CheckRow({check}: {check: Check}) {
  const settled = check.state === "pass";

  return (
    <li className={styles.check}>
      <Seal state={check.state} size={20} className={styles.seal} />
      <span className={styles.checkBody}>
        <span className={styles.checkLine}>
          <span className={styles.checkLabel}>{check.label}</span>
          {settled ? (
            <Hint label={`What ${check.label} read`}>
              <span className={styles.hintKey}>Read</span>
              <span className={`${styles.hintValue} chainvalue`}>{check.reading}</span>
              <span className={styles.hintKey}>Wanted</span>
              <span className={`${styles.hintValue} chainvalue`}>{check.expected}</span>
            </Hint>
          ) : null}
        </span>
        {settled ? null : (
          <>
            <span className={`${styles.reading} chainvalue`}>
              <span className={styles.key}>read</span>
              {check.reading}
            </span>
            <span className={`${styles.expected} chainvalue`}>
              <span className={styles.key}>want</span>
              {check.expected}
            </span>
          </>
        )}
      </span>
    </li>
  );
}

const VERDICT_SEAL = {admitted: "pass", rejected: "fail", unknown: "unknown"} as const;

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
        <TokenMark symbol={report.requested} size={40} />
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
          <Seal state={VERDICT_SEAL[report.verdict]} size={16} />
          {VERDICT_LABEL[report.verdict]}
        </span>
      </div>

      <AddressChip
        value={report.address}
        href={explorerAddress(report.address)}
        label={`the ${report.requested} contract address`}
      />

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
