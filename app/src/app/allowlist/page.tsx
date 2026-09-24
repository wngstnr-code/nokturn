import {TokenGateCard} from "@/components/TokenGateCard";
import {runGate, type GateReport} from "@/lib/allowlist-gate";
import {robinhoodMainnet} from "@/lib/chain";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

function Provenance({report}: {report: GateReport}) {
  return (
    <div className={styles.provenance}>
      <span className={styles.item}>
        Block
        <strong className="chainvalue">{report.blockNumber.toLocaleString("en-US")}</strong>
      </span>
      <span className={styles.item}>
        Chain
        <strong className="chainvalue">{report.chainId}</strong>
      </span>
      <span className={styles.item}>
        Read at
        <strong className="chainvalue">{report.readAt.replace("T", " ").slice(0, 19)} UTC</strong>
      </span>
      <span className={styles.item}>
        Endpoint
        <strong className="chainvalue">{robinhoodMainnet.rpcUrls.default.http[0]}</strong>
      </span>
    </div>
  );
}

export default async function AllowlistPage() {
  let report: GateReport | null = null;
  let failure: string | null = null;

  try {
    report = await runGate();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <p className={styles.eyebrow}>Allowlist gate</p>
        <h1 className={styles.title}>A ticker is not an identity</h1>
        <p className={styles.lead}>
          Nokturn never admits a token because of the symbol it reports. It admits a token because
          the ERC-1967 beacon slot holds the Robinhood Stock Token beacon and the contract answers
          uiMultiplier. Both checks run against mainnet below, at one block, so you can repeat them
          yourself.
        </p>
      </div>

      {failure !== null ? (
        <div className={styles.failure}>
          <h2>The chain did not answer</h2>
          <p>Nothing is shown rather than something invented. The endpoint returned: {failure}</p>
        </div>
      ) : null}

      {report === null ? null : (
        <>
          <Provenance report={report} />

          <p className={styles.sectionLabel}>Launch allowlist</p>
          <div className={styles.grid}>
            {report.reports
              .filter((entry) => entry.listed)
              .map((entry) => (
                <TokenGateCard key={entry.address} report={entry} />
              ))}
          </div>

          <p className={styles.sectionLabel}>Refused at the gate</p>
          <div className={styles.grid}>
            {report.reports
              .filter((entry) => !entry.listed)
              .map((entry) => (
                <div key={entry.address} className={styles.wide}>
                  <TokenGateCard report={entry} />
                </div>
              ))}
          </div>

          <p className={styles.footnote}>
            The refused contract calls itself GameStop and reports the symbol GME. It carries no
            beacon, no uiMultiplier, 44 bytes of code and a supply of 100 billion. It also traded
            roughly 29.6 million dollars across 250 thousand trades in July 2026, which is the
            reason this gate exists rather than a footnote about it. That volume figure comes from
            our own indexed queries, published in full on the{" "}
            <a
              href="https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026"
              target="_blank"
              rel="noreferrer"
            >
              Dune dashboard
            </a>
            . Every other number on this page was read from chain {report.chainId} at block{" "}
            <span className="chainvalue">{report.blockNumber.toLocaleString("en-US")}</span>.
          </p>
        </>
      )}
    </div>
  );
}
