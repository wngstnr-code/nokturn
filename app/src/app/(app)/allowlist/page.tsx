import {BlockArt, ChainArt, ClockArt} from "@/components/art/Art";
import {TokenGateCard} from "@/components/TokenGateCard";
import {Hint} from "@/components/ui/Hint";
import {OwlState} from "@/components/ui/OwlState";
import {runGate, type GateReport} from "@/lib/allowlist-gate";
import {robinhoodMainnet} from "@/lib/chain";
import {activeNetwork, type Network} from "@/lib/network";
import styles from "./page.module.css";

export const metadata = {title: "Allowlist"};

export const dynamic = "force-dynamic";

function Provenance({report, network}: {report: GateReport; network: Network}) {
  return (
    <div className={styles.provenance}>
      <span className={styles.item}>
        <BlockArt size={18} />
        Block
        <strong className="chainvalue">{report.blockNumber.toLocaleString("en-US")}</strong>
      </span>
      <span className={styles.item}>
        <ChainArt size={18} />
        {network.kind === "fork" && network.chainId === report.chainId ? network.name : "Chain"}
        <strong className="chainvalue">{report.chainId}</strong>
        {network.kind === "fork" && network.chainId === report.chainId && network.note ? (
          <Hint label="Where this chain comes from">{network.note}</Hint>
        ) : null}
      </span>
      <span className={styles.item}>
        <ClockArt size={18} />
        Read
        <strong className="chainvalue">{report.readAt.replace("T", " ").slice(0, 19)} UTC</strong>
        <Hint label="Which endpoint answered">
          Read from <span className="chainvalue">{robinhoodMainnet.rpcUrls.default.http[0]}</span>.
          Ask the same endpoint at the same block and you get the same answers.
        </Hint>
      </span>
    </div>
  );
}

export default async function AllowlistPage() {
  let report: GateReport | null = null;
  let failure: string | null = null;

  const network = await activeNetwork();

  try {
    report = await runGate();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Allowlist gate</p>
          <h1 className={styles.title}>A ticker is not an identity</h1>
          <p className={styles.lead}>
            A token gets in on two things read from the chain, never on the symbol it reports.
            <Hint label="Which two things">
              The ERC-1967 beacon slot has to hold the Robinhood Stock Token beacon, and the
              contract has to answer uiMultiplier. Both are read at one block, so you can repeat
              them yourself.
            </Hint>
          </p>
        </div>
      </div>

      {failure !== null ? (
        <OwlState mood="asleep" title="The chain did not answer" detail={failure}>
          Nothing is shown rather than something invented.
        </OwlState>
      ) : null}

      {report === null ? null : (
        <>
          <Provenance report={report} network={network} />

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
            The refused contract reports the symbol GME and a name to match. The card above shows
            what the chain says about it, an empty beacon slot, no uiMultiplier, and the code size
            and supply as read. Every number on this page was read from chain {report.chainId} at
            block <span className="chainvalue">{report.blockNumber.toLocaleString("en-US")}</span>.
          </p>
        </>
      )}
    </div>
  );
}
