import Link from "next/link";
import {ProvenanceStrip} from "@/components/Provenance";
import {VerifyCall} from "@/components/VerifyCall";
import {batchReceipt, coordinatorUrl} from "@/lib/coordinator/client";
import type {ApiError, BatchReceipt, FillReceipt} from "@/lib/coordinator/types";
import {shortAddress, units} from "@/lib/format";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

function amount(value: string, decimals: number, places: number): string {
  try {
    return units(BigInt(value), decimals, places);
  } catch {
    return "unreadable";
  }
}

/// A share, so it carries no sign.
function ratio(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return `${(parsed / 100).toFixed(2)}%`;
}

/// A change against the baseline, so it keeps its sign. docs/demo.md section 2.
function improvement(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return `${parsed > 0 ? "+" : ""}${parsed} bps`;
}

function difference(executed: string, baseline: string, decimals: number): string | null {
  try {
    const gap = BigInt(executed) - BigInt(baseline);
    const sign = gap > 0n ? "+" : gap < 0n ? "-" : "";
    const magnitude = gap < 0n ? -gap : gap;
    return `${sign}${units(magnitude, decimals, 4)}`;
  } catch {
    return null;
  }
}

/*
 * The baseline sits beside the result, never behind a disclosure. Binding rule,
 * docs/demo.md section 2.
 */
function Fill({fill}: {fill: FillReceipt}) {
  const moved = Number(fill.improvementBps);
  const better = Number.isFinite(moved) && moved >= 0;
  const gap = difference(fill.executedBuy, fill.baselineBuy, fill.buyToken.decimals);

  return (
    <article className={styles.fill}>
      <div className={styles.owner}>
        <span className={styles.ownerLabel}>Owner</span>
        <a
          className={`${styles.ownerValue} chainvalue`}
          href={fill.sellToken.explorerUrl}
          target="_blank"
          rel="noreferrer"
        >
          {shortAddress(fill.owner)}
        </a>
        {fill.partial ? <span className={styles.partial}>Partial fill</span> : null}
      </div>

      <div className={styles.legs}>
        <div className={styles.leg}>
          <span className={styles.legLabel}>Sold</span>
          <span className={`${styles.legValue} chainvalue`}>
            {amount(fill.executedSell, fill.sellToken.decimals, 4)} {fill.sellToken.symbol}
          </span>
        </div>
        <div className={styles.leg}>
          <span className={styles.legLabel}>Received</span>
          <span className={`${styles.legValue} chainvalue`}>
            {amount(fill.executedBuy, fill.buyToken.decimals, 4)} {fill.buyToken.symbol}
          </span>
        </div>
      </div>

      <div className={styles.compare}>
        <div className={styles.compareRow}>
          <span className={styles.compareLabel}>Alone on the venue</span>
          <span className={`${styles.compareValue} chainvalue`}>
            {amount(fill.baselineBuy, fill.buyToken.decimals, 4)} {fill.buyToken.symbol}
          </span>
        </div>
        <div className={styles.compareRow}>
          <span className={styles.compareLabel}>Difference</span>
          <span className={`${styles.compareValue} ${better ? styles.better : styles.worse} chainvalue`}>
            {gap === null ? "" : `${gap} ${fill.buyToken.symbol} `}
            {improvement(fill.improvementBps)}
          </span>
        </div>
      </div>

      <div className={styles.attribution}>
        <span className={styles.attributionLabel}>Where the difference came from</span>
        <div className={styles.attributionRow}>
          <span className="chainvalue">
            {amount(fill.attribution.nettedSell, fill.sellToken.decimals, 4)} {fill.sellToken.symbol}
          </span>{" "}
          met another intent inside the batch, so it never paid a spread
        </div>
        <div className={styles.attributionRow}>
          <span className="chainvalue">
            {amount(fill.attribution.routedSell, fill.sellToken.decimals, 4)} {fill.sellToken.symbol}
          </span>{" "}
          was routed to the venue in one order
        </div>
      </div>

      <VerifyCall call={fill.verifyBaseline} />
    </article>
  );
}

/* Publishes the baseline even though nothing settled. docs/demo.md section 3. */
function Failure({failure, receipt}: {failure: NonNullable<BatchReceipt["failure"]>; receipt: BatchReceipt}) {
  // A passthrough has no fills, so the token comes off the routed leg.
  const quote = receipt.fills[0]?.buyToken ?? receipt.venueRoutes[0]?.tokenOut;

  return (
    <section className={styles.failure}>
      <p className={styles.failureCode}>{failure.code}</p>
      <h2 className={styles.failureTitle}>{failure.reason}</h2>
      <p className={styles.failureBody}>
        Nothing settled, and the fee charged was {failure.feeCharged}. The comparison below was
        published anyway, at the same block, which is the number a batch that never ran would have
        no reason to show.
      </p>
      <div className={styles.failureGrid}>
        <div className={styles.failureCell}>
          Best solution offered
          <strong className="chainvalue">
            {failure.bestSolutionBuy === null
              ? "no solution was accepted"
              : `${amount(failure.bestSolutionBuy, quote?.decimals ?? 18, 4)} ${quote?.symbol ?? ""}`}
          </strong>
        </div>
        <div className={styles.failureCell}>
          Venue baseline
          <strong className="chainvalue">
            {failure.baselineBuy === null
              ? "the adapter could not answer"
              : `${amount(failure.baselineBuy, quote?.decimals ?? 18, 4)} ${quote?.symbol ?? ""}`}
          </strong>
        </div>
        <div className={styles.failureCell}>
          Shortfall
          <strong className="chainvalue">
            {failure.shortfall === null
              ? "not applicable"
              : `${amount(failure.shortfall, quote?.decimals ?? 18, 4)} ${quote?.symbol ?? ""}`}
          </strong>
        </div>
      </div>
    </section>
  );
}

function Unavailable({batchId, error}: {batchId: string; error: ApiError}) {
  const configured = coordinatorUrl() !== null;

  return (
    <div className={styles.unavailable}>
      <p className={styles.eyebrow}>Batch {batchId}</p>
      <h1 className={styles.unavailableTitle}>
        {configured ? "The receipt is not being served yet" : "No coordinator is configured"}
      </h1>
      <p className={styles.unavailableBody}>
        A receipt is assembled from settlement logs by the indexer, and until that exists this route
        refuses to answer rather than returning numbers nobody could trace. The refusal below is the
        coordinator&rsquo;s own words, passed through untouched.
      </p>
      <p className={`${styles.unavailableDetail} chainvalue`}>
        {error.code}. {error.message}
      </p>
      <Link className={styles.back} href="/batch">
        Back to the live tail
      </Link>
    </div>
  );
}

export default async function BatchReceiptPage({params}: {params: Promise<{batchId: string}>}) {
  const {batchId} = await params;
  const result = await batchReceipt(batchId);

  if (!result.ok) {
    return (
      <div className={styles.page}>
        <Unavailable batchId={batchId} error={result.error} />
      </div>
    );
  }

  const receipt = result.value;
  const settled = receipt.outcome === "settled";

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <p className={styles.eyebrow}>Batch receipt</p>
          <h1 className={styles.title}>
            <span className="chainvalue">#{receipt.batchId}</span>
          </h1>
        </div>
        <div className={styles.headFacts}>
          <span className={styles.headFact}>
            Session
            <strong>{receipt.sessionName}</strong>
          </span>
          <span className={styles.headFact}>
            Batch window
            <strong className="chainvalue">{receipt.batchDurationSeconds}s</strong>
          </span>
          <span className={styles.headFact}>
            Outcome
            <strong className={settled ? styles.settled : styles.notSettled}>{receipt.outcome}</strong>
          </span>
        </div>
      </header>

      {receipt.failure === null ? null : <Failure failure={receipt.failure} receipt={receipt} />}

      <div className={styles.totals}>
        <div className={styles.total}>
          <p className={styles.totalLabel}>Netting</p>
          <p className={`${styles.totalValue} chainvalue`}>{ratio(receipt.totals.nettingRatioBps)}</p>
          <p className={styles.totalHint}>Share that met another intent instead of a venue</p>
        </div>
        <div className={styles.total}>
          <p className={styles.totalLabel}>Participants</p>
          <p className={`${styles.totalValue} chainvalue`}>{receipt.participantCount}</p>
          <p className={styles.totalHint}>Distinct owners, which is what makes netting possible</p>
        </div>
        <div className={styles.total}>
          <p className={styles.totalLabel}>Total savings</p>
          <p className={`${styles.totalValue} chainvalue`}>
            {amount(receipt.totals.totalSavingsUsd, 18, 2)} USD
          </p>
          <p className={styles.totalHint}>Against the venue baseline at this block</p>
        </div>
        <div className={styles.total}>
          <p className={styles.totalLabel}>Intents</p>
          <p className={`${styles.totalValue} chainvalue`}>{receipt.intentCount}</p>
          <p className={styles.totalHint}>Counted at the moment collection closed</p>
        </div>
      </div>

      {receipt.fills.length === 0 ? null : (
        <>
          <p className={styles.sectionLabel}>Fills</p>
          <div className={styles.fills}>
            {receipt.fills.map((fill) => (
              <Fill key={fill.intentHash} fill={fill} />
            ))}
          </div>
        </>
      )}

      {receipt.venueRoutes.length === 0 ? null : (
        <>
          <p className={styles.sectionLabel}>Routed to a venue</p>
          <div className={styles.routes}>
            {receipt.venueRoutes.map((route) => (
              <div key={`${route.pool}-${route.amountIn}`} className={styles.route}>
                <span className={styles.routeLeg}>
                  <span className="chainvalue">
                    {amount(route.amountIn, route.tokenIn.decimals, 4)} {route.tokenIn.symbol}
                  </span>
                  {" into "}
                  <span className="chainvalue">
                    {amount(route.amountOut, route.tokenOut.decimals, 4)} {route.tokenOut.symbol}
                  </span>
                </span>
                <a
                  className={`${styles.routePool} chainvalue`}
                  href={route.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddress(route.pool)}
                </a>
              </div>
            ))}
          </div>
        </>
      )}

      {receipt.solutions.length === 0 ? null : (
        <>
          <p className={styles.sectionLabel}>Solutions seen, winners and losers</p>
          <div className={styles.solutions}>
            {receipt.solutions.map((solution) => (
              <div key={solution.solutionHash} className={styles.solution}>
                <span className={`${styles.solutionSolver} chainvalue`}>
                  {shortAddress(solution.solver)}
                </span>
                <span className={`${styles.solutionClaim} chainvalue`}>
                  {amount(solution.claimedSavingsUsd, 18, 2)} USD claimed
                </span>
                <span className={solution.accepted ? styles.accepted : styles.rejected}>
                  {solution.accepted ? "Accepted" : (solution.rejectionReason ?? "Rejected")}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <p className={styles.sectionLabel}>Provenance</p>
      <ProvenanceStrip at={receipt.provenance} />
    </div>
  );
}
