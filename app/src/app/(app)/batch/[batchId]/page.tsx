import Link from "next/link";
import {
  BatchOwl,
  ClockArt,
  MoonArt,
  Seal,
} from "@/components/art/Art";
import {ProvenanceStrip} from "@/components/Provenance";
import {AddressChip} from "@/components/ui/AddressChip";
import {Hint} from "@/components/ui/Hint";
import {OwlState} from "@/components/ui/OwlState";
import {VerifyCall} from "@/components/VerifyCall";
import {batchReceipt, coordinatorUrl} from "@/lib/coordinator/client";
import type {ApiError, BaselineFloor, BatchReceipt, FillReceipt} from "@/lib/coordinator/types";
import {explorerAddress} from "@/lib/chain";
import {sessionLabel, units} from "@/lib/format";
import styles from "./page.module.css";
import {TokenMark} from "@/components/TokenMark";

export const dynamic = "force-dynamic";

export async function generateMetadata({params}: {params: Promise<{batchId: string}>}) {
  const {batchId} = await params;
  return {title: `Batch #${batchId}`};
}

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

/// Out of a hundred, for the width of a bar. Null when the two parts cannot be read.
function nettedShare(netted: string, routed: string): number | null {
  try {
    const a = BigInt(netted);
    const b = BigInt(routed);
    if (a + b === 0n) return null;
    return Number((a * 10000n) / (a + b)) / 100;
  } catch {
    return null;
  }
}

/*
 * The baseline sits beside the result, never behind a disclosure. Binding rule,
 * docs/demo.md section 2. So the two figures stand side by side at the same size
 * with the difference between them, and only the explanation of a label is
 * folded away.
 *
 * The baseline of one fill is its share of the direction's baseline, not a quote
 * for that fill alone, and the label says so. Calling it what the sale would have
 * fetched alone was untrue on a routed batch. packages/shared/api-types.ts.
 */
function Fill({fill, chainId}: {fill: FillReceipt; chainId: number}) {
  const moved = Number(fill.improvementBps);
  const better = Number.isFinite(moved) && moved >= 0;
  const gap = difference(fill.executedBuy, fill.baselineBuy, fill.buyToken.decimals);
  const share = nettedShare(fill.attribution.nettedSell, fill.attribution.routedSell);

  return (
    <article className={styles.fill}>
      <div className={styles.owner}>
        <TokenMark symbol={fill.sellToken.symbol} size={36} />
        <span className={styles.sold}>
          Sold{" "}
          <strong className="chainvalue">
            {amount(fill.executedSell, fill.sellToken.decimals, 4)} {fill.sellToken.symbol}
          </strong>
        </span>
        <AddressChip value={fill.owner} href={explorerAddress(fill.owner, chainId)} label="the owner address" />
        {fill.partial ? <span className={styles.partial}>Partial fill</span> : null}
      </div>

      <div className={styles.versus}>
        <div className={styles.side}>
          <span className={styles.sideLabel}>In this batch</span>
          <span className={`${styles.sideValue} chainvalue`}>
            {amount(fill.executedBuy, fill.buyToken.decimals, 4)}
          </span>
          <span className={styles.sideUnit}>{fill.buyToken.symbol}</span>
        </div>
        <span className={`${styles.delta} ${better ? styles.better : styles.worse} chainvalue`}>
          {gap === null ? "" : `${gap} `}
          {improvement(fill.improvementBps)}
        </span>
        <div className={styles.side}>
          <span className={styles.sideLabel}>
            Its share of the venue baseline
            <Hint label="What the venue baseline is">
              The venue is asked once for everything sold in this direction, and that quote is
              split across the fills by size. So this is a share, not what this fill alone would
              have fetched. The call that checks the whole direction is further down.
            </Hint>
          </span>
          <span className={`${styles.sideValue} chainvalue`}>
            {amount(fill.baselineBuy, fill.buyToken.decimals, 4)}
          </span>
          <span className={styles.sideUnit}>{fill.buyToken.symbol}</span>
        </div>
      </div>

      <div className={styles.attribution}>
        <span className={styles.attributionLabel}>
          Where the difference came from
          <Hint label="How the two parts differ">
            The part that met another intent inside the batch never paid a spread. The rest was
            routed to the venue in one order.
          </Hint>
        </span>
        {share === null ? null : (
          <div className={styles.split} aria-hidden="true">
            <span className={styles.splitNetted} style={{width: `${share}%`}} />
          </div>
        )}
        <div className={styles.splitLegend}>
          <span>
            <i className={styles.dotNetted} />
            Met another intent{" "}
            <strong className="chainvalue">
              {amount(fill.attribution.nettedSell, fill.sellToken.decimals, 4)} {fill.sellToken.symbol}
            </strong>
          </span>
          <span>
            <i className={styles.dotRouted} />
            Routed to the venue{" "}
            <strong className="chainvalue">
              {amount(fill.attribution.routedSell, fill.sellToken.decimals, 4)} {fill.sellToken.symbol}
            </strong>
          </span>
        </div>
      </div>

    </article>
  );
}

/*
 * The check a reader can run. A fill's baseline is its pro rata share of the
 * direction's baseline, so the venue quote for one fill alone does not match it on
 * a routed batch and would look like a discrepancy. The floor is the venue quote
 * for the whole direction, which is what Settlement holds the solution to.
 * docs/audit-provenansi-backend.md section 1.
 */
function Floor({floor}: {floor: BaselineFloor}) {
  return (
    <article className={styles.floor}>
      <div className={styles.floorHead}>
        <span className={styles.floorPair}>
          {floor.sellToken.symbol} to {floor.buyToken.symbol}
        </span>
        <span className={styles.floorFills}>
          {floor.fills} {floor.fills === 1 ? "fill" : "fills"}
        </span>
        <span
          className={`${styles.outcome} ${
            floor.holds === true ? styles.settled : styles.notSettled
          }`}
        >
          <Seal state={floor.holds === true ? "pass" : floor.holds === false ? "fail" : "unknown"} size={16} />
          {floor.holds === true
            ? "At or above the venue"
            : floor.holds === false
              ? "Below the venue"
              : "The venue could not be read"}
        </span>
      </div>
      <div className={styles.floorFigures}>
        <span>
          Sold
          <strong className="chainvalue">
            {amount(floor.executedSell, floor.sellToken.decimals, 4)} {floor.sellToken.symbol}
          </strong>
        </span>
        <span>
          Baseline the solution was held to
          <strong className="chainvalue">
            {amount(floor.baselineBuy, floor.buyToken.decimals, 4)} {floor.buyToken.symbol}
          </strong>
        </span>
        <span>
          Venue quote for the same amount
          <strong className="chainvalue">
            {amount(floor.verifyFloor.expected, floor.buyToken.decimals, 4)} {floor.buyToken.symbol}
          </strong>
        </span>
      </div>
      <VerifyCall call={floor.verifyFloor} />
    </article>
  );
}

/*
 * The reason a batch passed through, said plainly. Settlement carries these as
 * strings on BatchPassthrough and the indexer names them, and the difference
 * between them matters. One is an honest zero, the other is an owner walking
 * away after a solution was already locked.
 */
const WHY: Record<string, string> = {
  SavingsBelowThreshold: "No solution beat the venue by enough to be worth settling",
  IntentCollectionFailed: "An owner's sell leg could not be pulled when the batch closed",
  WinnerNeverFinalized: "The winning solver never came back to finalize",
  BatchPassthrough: "The batch passed through without settling",
  WorseThanBaseline: "Every solution offered less than the venue would have",
};

/* Publishes the baseline even though nothing settled. docs/demo.md section 3. */
function Failure({failure, receipt}: {failure: NonNullable<BatchReceipt["failure"]>; receipt: BatchReceipt}) {
  // A passthrough has no fills, so the token comes off the routed leg.
  const quote = receipt.fills[0]?.buyToken ?? receipt.venueRoutes[0]?.tokenOut;
  const filled = receipt.fills.length > 0;

  return (
    <section className={styles.failure}>
      <p className={styles.failureCode}>{failure.code}</p>
      <h2 className={styles.failureTitle}>{WHY[failure.code] ?? failure.reason}</h2>
      {WHY[failure.code] === undefined ? null : (
        <p className={styles.failureReason}>
          Settlement recorded the reason as <span className="chainvalue">{failure.reason}</span>
        </p>
      )}
      {/*
        A batch that finds no saving worth keeping can still fill, by sending the
        intent to the venue at the venue's own price. Saying nothing settled over a
        fill would be false, so the two cases get their own sentence.
      */}
      <p className={styles.failureBody}>
        {filled
          ? `The intent was filled, at the venue's own price and no better. The fee charged was ${failure.feeCharged}. The comparison below is published all the same, at the same block.`
          : `Nothing settled, and the fee charged was ${failure.feeCharged}. The comparison below was published anyway, at the same block, which is the number a batch that never ran would have no reason to show.`}
      </p>
      {failure.bestSolutionBuy === null &&
      failure.baselineBuy === null &&
      failure.shortfall === null ? null : (
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
      )}
    </section>
  );
}

function Unavailable({batchId, error}: {batchId: string; error: ApiError}) {
  const configured = coordinatorUrl() !== null;

  return (
    <>
      <OwlState
        mood={configured ? "searching" : "asleep"}
        title={configured ? `No receipt for batch ${batchId}` : "No coordinator is configured"}
        detail={`${error.code}. ${error.message}`}
      >
        A receipt is put together from settlement logs by the indexer. Until it has this batch, the
        screen shows nothing rather than numbers nobody could trace.
      </OwlState>
      <Link className={styles.back} href="/batch">
        Back to all batches
      </Link>
    </>
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
        <BatchOwl seed={receipt.batchId} size={76} />
        <div className={styles.headName}>
          <p className={styles.eyebrow}>Batch receipt</p>
          <h1 className={styles.title}>
            <span className="chainvalue">#{receipt.batchId}</span>
          </h1>
        </div>
        <div className={styles.headFacts}>
          <span
            className={`${styles.outcome} ${settled && receipt.failure === null ? styles.settled : styles.notSettled}`}
          >
            <Seal state={settled && receipt.failure === null ? "pass" : "unknown"} size={17} />
            {receipt.outcome}
          </span>
          <span className={styles.headFact}>
            <MoonArt size={18} />
            {sessionLabel(receipt.sessionName)}
          </span>
          <span className={styles.headFact}>
            <ClockArt size={18} />
            <span className="chainvalue">{receipt.batchDurationSeconds}s</span> window
          </span>
        </div>
      </header>

      {receipt.failure === null ? null : <Failure failure={receipt.failure} receipt={receipt} />}

      <div className={styles.totals}>
        <div className={styles.total}>
          <p className={styles.totalLabel}>
            Netting
            <Hint label="What netting is">
              The share of the batch that met another intent instead of going to a venue.
            </Hint>
          </p>
          <p className={`${styles.totalValue} chainvalue`}>{ratio(receipt.totals.nettingRatioBps)}</p>
        </div>
        <div className={styles.total}>
          <p className={styles.totalLabel}>
            Total savings
            <Hint label="Savings against what">Against the venue baseline at this block.</Hint>
          </p>
          <p className={`${styles.totalValue} chainvalue`}>
            {amount(receipt.totals.totalSavingsUsd, 18, 2)} USD
          </p>
        </div>
        <div className={styles.total}>
          <p className={styles.totalLabel}>
            Participants
            <Hint label="Who counts as a participant">
              Distinct owners, which is what makes netting possible.
            </Hint>
          </p>
          <p className={`${styles.totalValue} chainvalue`}>{receipt.participantCount}</p>
        </div>
        <div className={styles.total}>
          <p className={styles.totalLabel}>
            Intents
            <Hint label="When intents are counted">Counted at the moment collection closed.</Hint>
          </p>
          <p className={`${styles.totalValue} chainvalue`}>{receipt.intentCount}</p>
        </div>
      </div>

      {receipt.fills.length === 0 ? null : (
        <>
          <p className={styles.sectionLabel}>Fills</p>
          <div className={styles.fills}>
            {receipt.fills.map((fill) => (
              <Fill key={fill.intentHash} fill={fill} chainId={receipt.provenance.chainId} />
            ))}
          </div>
        </>
      )}

      {receipt.baselineFloors.length === 0 ? null : (
        <>
          <p className={styles.sectionLabel}>Check it yourself, one call per direction</p>
          <div className={styles.fills}>
            {receipt.baselineFloors.map((floor) => (
              <Floor key={`${floor.sellToken.address}-${floor.buyToken.address}`} floor={floor} />
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
                <AddressChip value={route.pool} href={route.explorerUrl} label="the pool address" />
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
                <AddressChip
                  value={solution.solver}
                  href={explorerAddress(solution.solver, receipt.provenance.chainId)}
                  label="the solver address"
                />
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
