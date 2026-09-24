import type {Provenance} from "@/lib/coordinator/types";
import styles from "./Provenance.module.css";

function utc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

/* The testnet note is said up front, not footnoted. docs/demo.md section 7. */
function sourceLabel(source: Provenance["source"]): string {
  if (source.kind === "mainnet") return "Mainnet";
  if (source.kind === "testnet") return `Testnet, ${source.note}`;
  return `Fork of chain ${source.forkedFrom}, pinned at block ${source.pinnedBlock}`;
}

export function ProvenanceStrip({at, explorer}: {at: Provenance; explorer?: string}) {
  return (
    <div className={styles.strip}>
      <span>
        Block
        <strong className="chainvalue">{at.blockNumber}</strong>
      </span>
      <span>
        Chain
        <strong className="chainvalue">{at.chainId}</strong>
      </span>
      <span>
        Block time
        <strong className="chainvalue">{utc(at.blockTimestamp)} UTC</strong>
      </span>
      <span>
        Read from
        <strong>{sourceLabel(at.source)}</strong>
      </span>
      {at.transactionHash === undefined ? null : (
        <span>
          Transaction
          <strong>
            {explorer === undefined ? (
              <span className="chainvalue">{at.transactionHash}</span>
            ) : (
              <a className="chainvalue" href={explorer} target="_blank" rel="noreferrer">
                {at.transactionHash}
              </a>
            )}
          </strong>
        </span>
      )}
    </div>
  );
}
