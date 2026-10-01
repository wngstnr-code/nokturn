import {NettingChart, type Point} from "./NettingChart";
import {NettingIcon} from "@/components/Icons";
import {nettingCurve} from "@/lib/coordinator/client";
import type {NettingCurveResponse} from "@/lib/coordinator/types";
import styles from "./page.module.css";

export const metadata = {title: "Netting backtest"};

export const dynamic = "force-dynamic";

/*
 * The copy this build carries, from docs/parameter.md section 4. It is drawn only
 * when no coordinator answers, and the page says which of the two it is showing.
 * The coordinator serves the same rows from the Dune export, and they were checked
 * equal to these on 1 October 2026.
 */
const CARRIED: Point[] = [
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

/// The session the quoted figures come from. The other two are served but not drawn.
const QUOTED_SESSION = "off_hours_weekday";

type Loaded = {
  curve: Point[];
  served: NettingCurveResponse["source"] | null;
  statement: string | null;
};

async function load(): Promise<Loaded> {
  const answer = await nettingCurve();
  if (!answer.ok) return {curve: CARRIED, served: null, statement: null};

  const curve = answer.value.rows
    .filter((row) => row.session === QUOTED_SESSION)
    .sort((a, b) => a.sharePct - b.sharePct)
    .map((row) => ({
      share: row.sharePct,
      counterparty: row.nettingCounterpartyPct,
      gross: row.nettingGrossPct,
      traders: row.avgTradersPerBatch,
    }));

  // A served curve with no rows for this session is not a reason to draw nothing.
  if (curve.length === 0) return {curve: CARRIED, served: null, statement: null};
  return {curve, served: answer.value.source, statement: answer.value.statement};
}

/* Half up on the decimal as written, so 50.05 reads 50,1 the way the pitch quotes it. */
function figure(value: number, places: number): string {
  const scale = 10 ** places;
  return (Math.round((value + 1e-9) * scale) / scale).toFixed(places).replace(".", ",");
}

function at(curve: Point[], share: number): Point | undefined {
  return curve.find((point) => point.share === share);
}

export default async function NettingPage() {
  const {curve, served, statement} = await load();
  const [p5, p10, p20, p100] = [5, 10, 20, 100].map((share) => at(curve, share));

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.badgeRow}>
          <span className={styles.heroMark} aria-hidden="true">
            <NettingIcon size={24} />
          </span>
          <span className={styles.badge}>Backtest</span>
        </div>
        <p className={styles.eyebrow}>Netting against share of flow</p>
        <h1 className={styles.title}>More flow is not a promise, it has a slope</h1>
        <p className={styles.lead}>
          {statement ??
            "Every line on this page is a counterfactual simulation over real trades. The inputs are August 2026 flow on Robinhood Chain, the mechanism is hypothetical because Nokturn did not exist then. This is a backtest, never a measurement."}{" "}
          The word matters enough that it is printed on the chart rather than said once in a script.
        </p>
      </section>

      <NettingChart points={curve} />

      {p5 && p10 && p20 && p100 ? (
        <section className={styles.callouts}>
          <div className={styles.callout}>
            <p className={styles.calloutLabel}>What we quote</p>
            <p className={`${styles.calloutValue} chainvalue`}>
              {figure(p10.counterparty, 0)} to {figure(p20.counterparty, 0)}%
            </p>
            <p className={styles.calloutHint}>
              Between counterparties, at a realistic early share of 10 to 20%. Not{" "}
              {figure(p100.counterparty, 2)}% and not {figure(p100.gross, 2)}%.
            </p>
          </div>
          <div className={styles.callout}>
            <p className={styles.calloutLabel}>The slope itself</p>
            <p className={`${styles.calloutValue} chainvalue`}>
              {figure(p5.counterparty, 1)}% to {figure(p100.counterparty, 1)}%
            </p>
            <p className={styles.calloutHint}>
              From 5% of flow to all of it. The shape is the argument, not any single point on it.
            </p>
          </div>
          <div className={styles.callout}>
            <p className={styles.calloutLabel}>Traders per batch, early</p>
            <p className={`${styles.calloutValue} chainvalue`}>
              {figure(p10.traders, 1)} to {figure(p20.traders, 1)}
            </p>
            <p className={styles.calloutHint}>
              Off hours, at 10 to 20% share. The netting is real and the batches are thin. Both are
              true at once.
            </p>
          </div>
        </section>
      ) : null}

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
            {curve.map((row) => (
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
        {served === null ? (
          <>
            Drawn from the copy this build carries, taken from the project parameters, because no
            coordinator answered. The inputs are our own queries over August 2026 flow, off hours,
            45 second batches, against the v1.0 allowlist.
          </>
        ) : (
          <>
            Served by the coordinator from the export of{" "}
            <a href={served.duneQueryUrl} target="_blank" rel="noreferrer">
              Dune query <span className="chainvalue">{served.duneQueryId}</span>
            </a>
            , exported <span className="chainvalue">{served.exportedAt}</span>, over{" "}
            <span className="chainvalue">{served.window}</span> in{" "}
            <span className="chainvalue">{served.batchSeconds}</span> second batches, off hours on
            weekdays.
          </>
        )}{" "}
        The queries are permanent and public on the{" "}
        <a href={DUNE} target="_blank" rel="noreferrer">
          Dune dashboard
        </a>
        , so the inputs can be rerun. The mechanism on top of them cannot, because it did not exist
        in August.
      </p>
    </div>
  );
}
