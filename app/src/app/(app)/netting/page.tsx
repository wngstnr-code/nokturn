import {NettingChart, type Point} from "./NettingChart";
import {nettingCurve} from "@/lib/coordinator/client";
import type {NettingCurveResponse} from "@/lib/coordinator/types";
import {OwlState} from "@/components/ui/OwlState";
import {activeNetwork} from "@/lib/network";
import styles from "./page.module.css";

export const metadata = {title: "Netting backtest"};

export const dynamic = "force-dynamic";

const DUNE =
  "https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026";

/// The session the quoted figures come from. The other two are served but not drawn.
const QUOTED_SESSION = "off_hours_weekday";

type Loaded = {
  curve: Point[];
  served: NettingCurveResponse["source"];
  statement: string;
};

/*
 * Only what the coordinator serves from the Dune export. No copy is kept in this
 * build, because a number the page cannot point at a query for does not belong on it.
 */
async function load(): Promise<Loaded | null> {
  const answer = await nettingCurve();
  if (!answer.ok) return null;

  const curve = answer.value.rows
    .filter((row) => row.session === QUOTED_SESSION)
    .sort((a, b) => a.sharePct - b.sharePct)
    .map((row) => ({
      share: row.sharePct,
      counterparty: row.nettingCounterpartyPct,
      gross: row.nettingGrossPct,
      traders: row.avgTradersPerBatch,
    }));

  if (curve.length === 0) return null;
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
  // The testnet leaves every flow figure off, and this page goes with them. The
  // backtest itself is real August flow, so the way to it is still given.
  if ((await activeNetwork()).kind === "testnet") {
    return (
      <div className={styles.page}>
        <OwlState mood="waiting" title="The netting backtest lives on mainnet">
          This is the testnet, where flow figures are not shown. The backtest replays real August
          2026 trades and is on the{" "}
          <a href="https://app.nokturn.xyz/netting" target="_blank" rel="noreferrer">
            mainnet app
          </a>
          .
        </OwlState>
      </div>
    );
  }

  const loaded = await load();
  if (loaded === null) {
    return (
      <div className={styles.page}>
        <section className={styles.hero}>
          <p className={styles.eyebrow}>Netting against share of flow</p>
          <h1 className={styles.title}>No curve to draw right now</h1>
          <p className={styles.lead}>
            The coordinator did not answer, and this page draws nothing it cannot trace to a query.
            The backtest itself is public on the{" "}
            <a href={DUNE} target="_blank" rel="noreferrer">
              Dune dashboard
            </a>
            .
          </p>
        </section>
      </div>
    );
  }
  const {curve, served, statement} = loaded;
  const [p5, p10, p20, p100] = [5, 10, 20, 100].map((share) => at(curve, share));

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>Netting against share of flow</p>
        <h1 className={styles.title}>More flow is not a promise, it has a slope</h1>
        <p className={styles.lead}>
          {statement}{" "}
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
        Served by the coordinator from the export of{" "}
        <a href={served.duneQueryUrl} target="_blank" rel="noreferrer">
          Dune query <span className="chainvalue">{served.duneQueryId}</span>
        </a>
        , exported <span className="chainvalue">{served.exportedAt}</span>, over{" "}
        <span className="chainvalue">{served.window}</span> in{" "}
        <span className="chainvalue">{served.batchSeconds}</span> second batches, off hours on
        weekdays.{" "}
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
