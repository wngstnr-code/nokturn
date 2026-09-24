import styles from "./SiteFooter.module.css";

const REPO = "https://github.com/wngstnr-code/nokturn";
const DUNE =
  "https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026";
const EXPLORER = "https://robinhood-testnet.cloud.blockscout.com";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.bottom}>
        <p className={styles.note}>Nokturn</p>
        <div className={styles.links}>
          <a href={REPO} target="_blank" rel="noreferrer">
            Source
          </a>
          <a href={DUNE} target="_blank" rel="noreferrer">
            Measurements
          </a>
          <a href={EXPLORER} target="_blank" rel="noreferrer">
            Explorer
          </a>
        </div>
      </div>
    </footer>
  );
}
