import {ProvenanceStrip} from "@/components/Provenance";
import {auction, coordinatorUrl} from "@/lib/coordinator/client";
import type {ApiError, AuctionResponse} from "@/lib/coordinator/types";
import {units} from "@/lib/format";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

/*
 * Kept out of the navigation until the open decision in docs/demo.md section 3b
 * priority 3 is made. Its participants are demo wallets we wrote intents for.
 */

const PHASE_COPY: Record<AuctionResponse["phase"], string> = {
  accumulating: "Taking commitments. Nothing is disclosed yet",
  disclosing: "Publishing the imbalance while commitments are still open",
  frozen: "Book frozen, waiting for the bell",
  crossed: "Crossed. The print below is the one that was issued",
  aborted: "Abandoned without a cross",
};

function amount(value: string, decimals: number, places: number): string {
  try {
    return units(BigInt(value), decimals, places);
  } catch {
    return "unreadable";
  }
}

function Unavailable({auctionId, error}: {auctionId: string; error: ApiError}) {
  const configured = coordinatorUrl() !== null;

  return (
    <div className={styles.unavailable}>
      <p className={styles.eyebrow}>Auction {auctionId}</p>
      <h1 className={styles.unavailableTitle}>
        {configured ? "No auction has opened yet" : "No coordinator is configured"}
      </h1>
      <p className={styles.unavailableBody}>
        A closing cross needs a session that actually reached the bell with live feeds behind it.
        Until one has, this route refuses rather than showing a shape filled with numbers nobody
        could trace. The refusal below is the coordinator&rsquo;s own words.
      </p>
      <p className={`${styles.unavailableDetail} chainvalue`}>
        {error.code}. {error.message}
      </p>
    </div>
  );
}

export default async function AuctionPage({params}: {params: Promise<{auctionId: string}>}) {
  const {auctionId} = await params;
  const result = await auction(auctionId);

  if (!result.ok) {
    return (
      <div className={styles.page}>
        <Unavailable auctionId={auctionId} error={result.error} />
      </div>
    );
  }

  const book = result.value;
  const imbalance = book.imbalance === null ? null : BigInt(book.imbalance);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <p className={styles.eyebrow}>
            {book.kind === "close" ? "Closing cross" : "Opening cross"} · {book.token.symbol}
          </p>
          <h1 className={styles.title}>
            {book.result === null ? "Not crossed yet" : `${amount(book.result.price, 18, 6)} per ${book.token.symbol}`}
          </h1>
          <p className={styles.phase}>{PHASE_COPY[book.phase]}</p>
        </div>
      </header>

      <div className={styles.grid}>
        <div className={styles.card}>
          <p className={styles.label}>Indicative price</p>
          <p className={`${styles.value} chainvalue`}>
            {book.indicativePrice === null ? "not published" : amount(book.indicativePrice, 18, 6)}
          </p>
          <p className={styles.hint}>Published while the book is still open, so it can be acted on</p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>Imbalance</p>
          <p className={`${styles.value} chainvalue`}>
            {imbalance === null
              ? "not published"
              : `${imbalance > 0n ? "buy" : "sell"} ${amount(
                  (imbalance < 0n ? -imbalance : imbalance).toString(),
                  book.token.decimals,
                  4,
                )}`}
          </p>
          <p className={styles.hint}>Which side is short, named before the cross rather than after</p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>Participants</p>
          <p className={`${styles.value} chainvalue`}>{book.participantCount}</p>
          <p className={styles.hint}>Distinct committers in this book</p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>Collar</p>
          <p className={`${styles.value} chainvalue`}>{book.collarBps} bps</p>
          <p className={styles.hint}>
            How far the cross may sit from the reference. Extensions so far: {book.extensions}
          </p>
        </div>
      </div>

      {book.result === null ? null : (
        <section className={styles.print}>
          <p className={styles.printLabel}>The print</p>
          <div className={styles.printGrid}>
            <div className={styles.printCell}>
              Price
              <strong className="chainvalue">{amount(book.result.price, 18, 6)}</strong>
            </div>
            <div className={styles.printCell}>
              Crossed volume
              <strong className="chainvalue">
                {amount(book.result.volume, book.token.decimals, 6)} {book.token.symbol}
              </strong>
            </div>
            <div className={styles.printCell}>
              Participants
              <strong className="chainvalue">{book.result.participants}</strong>
            </div>
            <div className={styles.printCell}>
              Sufficient
              <strong className={book.result.sufficient ? styles.ok : styles.bad}>
                {book.result.sufficient ? "yes, the print was issued" : "no, nothing was printed"}
              </strong>
            </div>
          </div>
        </section>
      )}

      <p className={styles.sectionLabel}>Provenance</p>
      <ProvenanceStrip at={book.provenance} />
    </div>
  );
}
