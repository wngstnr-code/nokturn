import {Countdown} from "./Countdown";
import {explorerAddress} from "@/lib/chain";
import {readSession, SESSION_NAMES, type SessionReport, type TokenOracle} from "@/lib/session";
import {baseTokens} from "@/lib/tokens";
import {units} from "@/lib/format";
import {CHAIN_ID_TESTNET} from "@shared/addresses";
import {Session} from "@shared/types";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

const CHAIN = CHAIN_ID_TESTNET;

function utc(seconds: bigint | number): string {
  return new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function OracleRow({token}: {token: TokenOracle}) {
  const priceOf = (value: bigint | null, error: string | null) =>
    value === null ? (
      <span className={`${styles.badge} ${styles.warn} chainvalue`}>{error ?? "unreadable"}</span>
    ) : (
      <span className="chainvalue">{units(value, 18, 4)}</span>
    );

  return (
    <tr>
      <td>
        <div className={styles.symbol}>{token.symbol}</div>
        <a
          className={`${styles.muted} chainvalue`}
          href={explorerAddress(token.address, CHAIN)}
          target="_blank"
          rel="noreferrer"
        >
          {token.address}
        </a>
      </td>
      <td>{priceOf(token.refPrice, token.refError)}</td>
      <td>{priceOf(token.chainlink, token.dualError)}</td>
      <td>{priceOf(token.uniTwap, token.dualError)}</td>
      <td>
        {token.agree === null ? (
          <span className={styles.muted}>not answered</span>
        ) : (
          <span className={`${styles.badge} ${token.agree ? styles.ok : styles.bad}`}>
            {token.agree ? "Agree" : "Disagree"}
          </span>
        )}
      </td>
      <td>
        {token.tokenSession === null ? (
          <span className={styles.muted}>not answered</span>
        ) : (
          <span
            className={`${styles.badge} ${token.tokenSession === Session.PROTECTIVE ? styles.bad : styles.ok}`}
          >
            {SESSION_NAMES[token.tokenSession]}
          </span>
        )}
      </td>
    </tr>
  );
}

function Report({report}: {report: SessionReport}) {
  const batch = report.batchDuration;

  return (
    <>
      <div className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Session right now</p>
          <h1 className={styles.session}>{SESSION_NAMES[report.session]}</h1>
          <p className={styles.until}>
            Next transition in{" "}
            <Countdown target={Number(report.nextTransition)} readAt={Number(report.blockTimestamp)} />, at{" "}
            <span className="chainvalue">{utc(report.nextTransition)} UTC</span>
          </p>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.card}>
          <p className={styles.label}>Batch window</p>
          <p className={`${styles.value} chainvalue`}>{batch === 0 ? "none" : `${batch}s`}</p>
          <p className={styles.hint}>
            {batch === 0 ? "This session settles by auction, not by batch" : "Intents collect for this long"}
          </p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>Price band</p>
          <p className={`${styles.value} chainvalue`}>{report.maxDeviationBps} bps</p>
          <p className={styles.hint}>Furthest an execution may sit from the reference</p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>Guard band</p>
          <p className={styles.value}>{report.inGuardBand ? "Inside" : "Outside"}</p>
          <p className={styles.hint}>Near a session edge, where a batch could straddle two states</p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>New York day</p>
          <p className={`${styles.value} chainvalue`}>{report.easternDay}</p>
          <p className={styles.hint}>Daily budgets reset on this, not on UTC midnight</p>
        </div>
      </div>

      <p className={styles.sectionLabel}>Price sources, per token</p>
      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Token</th>
              <th>Reference</th>
              <th>Chainlink</th>
              <th>Uniswap V3 TWAP</th>
              <th>Agreement</th>
              <th>Token session</th>
            </tr>
          </thead>
          <tbody>
            {report.tokens.map((token) => (
              <OracleRow key={token.address} token={token} />
            ))}
          </tbody>
        </table>
      </div>

      <p className={styles.note}>
        A reading that says FeedNotSet is the contract answering, not the page failing. Chain{" "}
        {report.chainId} carries no Chainlink equity feeds, so PriceOracle has none registered for
        these test tokens and says so. The same screen against a chain with feeds shows prices.
      </p>

      <div className={styles.provenance}>
        <span>
          Block
          <strong className="chainvalue">{report.blockNumber.toLocaleString("en-US")}</strong>
        </span>
        <span>
          Chain
          <strong className="chainvalue">{report.chainId}</strong>
        </span>
        <span>
          Block time
          <strong className="chainvalue">{utc(report.blockTimestamp)} UTC</strong>
        </span>
        <span>
          SessionManager
          <strong>
            <a
              className="chainvalue"
              href={explorerAddress(report.sessionManager, CHAIN)}
              target="_blank"
              rel="noreferrer"
            >
              {report.sessionManager}
            </a>
          </strong>
        </span>
        <span>
          PriceOracle
          <strong>
            <a
              className="chainvalue"
              href={explorerAddress(report.oracle, CHAIN)}
              target="_blank"
              rel="noreferrer"
            >
              {report.oracle}
            </a>
          </strong>
        </span>
      </div>
    </>
  );
}

export default async function SessionPage() {
  let report: SessionReport | null = null;
  let failure: string | null = null;

  try {
    const tokens = await baseTokens(CHAIN);
    report = await readSession(CHAIN, tokens);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className={styles.page}>
      {failure !== null ? (
        <div className={styles.failure}>
          <h2>The chain did not answer</h2>
          <p>Nothing is shown rather than something invented. The endpoint returned: {failure}</p>
        </div>
      ) : null}
      {report === null ? null : <Report report={report} />}
    </div>
  );
}
