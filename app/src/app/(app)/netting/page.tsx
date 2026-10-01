import {NettingChart, type Point} from "./NettingChart";
import styles from "./page.module.css";

/*
 * Copied from docs/parameter.md section 4, never recomputed. A second
 * computation would be a second answer.
 */
const CURVE: Point[] = [
  {share: 5, counterparty: 21.43, gross: 31.92, traders: 1.94},
  {share: 10, counterparty: 27.19, gross: 37.99, traders: 2.47},
  {share: 15, counterparty: 30.43, gross: 41.17, traders: 2.9},
  {share: 20, counterparty: 33.39, gross: 44.41, traders: 3.29},
  {share: 25, counterparty: 35.73, gross: 47.06, traders: 3.63},
  {share: 30, counterparty: 38.06, gross: 49.51, traders: 3.95},
  {share: 50, counterparty: 42.81, gross: 54.99, traders: 5.09},
  {share: 75, counterparty: 46.65, gross: 59.79, traders: 6.35},
  {share: 100, counterparty: 50.05, gross: 63.76, traders: 7.47},
];

const DUNE =
  "https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026";

export default function NettingPage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.badgeRow}>
          <span className={styles.badge}>Backtest</span>
        </div>
        <p className={styles.eyebrow}>Netting against share of flow</p>
        <h1 className={styles.title}>More flow is not a promise, it has a slope</h1>
        <p className={styles.lead}>
          Every line on this page is a counterfactual simulation over real trades. The inputs are
          August 2026 flow on Robinhood Chain, the mechanism is hypothetical because Nokturn did not
          exist then. This is a backtest, never a measurement, and the word matters enough that it
          is printed on the chart rather than said once in a script.
        </p>
      </section>

      <NettingChart points={CURVE} />

      <section className={styles.callouts}>
        <div className={styles.callout}>
          <p className={styles.calloutLabel}>What we quote</p>
          <p className={`${styles.calloutValue} chainvalue`}>27 to 33%</p>
          <p className={styles.calloutHint}>
            Between counterparties, at a realistic early share of 10 to 20%. Not 50,05% and not
            63,76%.
          </p>
        </div>
        <div className={styles.callout}>
          <p className={styles.calloutLabel}>The slope itself</p>
          <p className={`${styles.calloutValue} chainvalue`}>21,4% to 50,1%</p>
          <p className={styles.calloutHint}>
            From 5% of flow to all of it. The shape is the argument, not any single point on it.
          </p>
        </div>
        <div className={styles.callout}>
          <p className={styles.calloutLabel}>Traders per batch, early</p>
          <p className={`${styles.calloutValue} chainvalue`}>2,5 to 3,3</p>
          <p className={styles.calloutHint}>
            Off hours, at 10 to 20% share. The netting is real and the batches are thin. Both are
            true at once.
          </p>
        </div>
      </section>

      <section className={styles.method}>
        <h2 className={styles.methodTitle}>Why the number went up when the method got stricter</h2>
        <p className={styles.methodBody}>
          An earlier version of this curve said 21 to 29% at the same share levels. It used the
          gross definition, which still counts a bot trading back and forth against itself as
          netting. The counterparty definition throws those out, and the number came back higher, at
          27 to 33%. The method was tightened and the result improved. Both curves are drawn above
          so that claim can be checked rather than taken.
        </p>
        <p className={styles.methodBody}>
          The curve is also a diagnostic, not a showpiece. If netting on mainnet lands far below the
          line at the share we actually have, the thing at fault is the solver or the batch
          duration, not the market.
        </p>
      </section>

      <p className={styles.sectionLabel}>The numbers behind the chart</p>
      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Share of flow</th>
              <th>Between counterparties</th>
              <th>Gross</th>
              <th>Traders per batch</th>
            </tr>
          </thead>
          <tbody>
            {CURVE.map((row) => (
              <tr key={row.share} className={row.share === 10 || row.share === 20 ? styles.quoted : undefined}>
                <td className="chainvalue">{row.share}%</td>
                <td className="chainvalue">{row.counterparty.toFixed(2)}%</td>
                <td className="chainvalue">{row.gross.toFixed(2)}%</td>
                <td className="chainvalue">{row.traders.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className={styles.footnote}>
        Source: our own indexed queries over August 2026 flow, off hours, 45 second batches, against
        the v1.0 allowlist. The nine queries are permanent and public on the{" "}
        <a href={DUNE} target="_blank" rel="noreferrer">
          Dune dashboard
        </a>
        , so the inputs can be rerun. The mechanism on top of them cannot, because it did not exist
        in August.
      </p>
    </div>
  );
}
