import Link from "next/link";
import {Seal} from "@/components/art/Art";
import {Hint} from "@/components/ui/Hint";
import {OwlState} from "@/components/ui/OwlState";
import {Admission} from "@/components/auction/Admission";
import {AuctionLive} from "@/components/auction/AuctionLive";
import {CommitCard} from "@/components/auction/CommitCard";
import {ProvenanceStrip} from "@/components/Provenance";
import {auction, coordinatorUrl, noActiveSolver} from "@/lib/coordinator/client";
import type {ApiError, AuctionResponse} from "@/lib/coordinator/types";
import {units} from "@/lib/format";
import {active} from "@/lib/network";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({params}: {params: Promise<{auctionId: string}>}) {
  const {auctionId} = await params;
  return {title: `Auction #${auctionId}`};
}

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
    <OwlState
      mood={configured ? "searching" : "asleep"}
      title={configured ? `Auction ${auctionId} has not opened` : "No coordinator is configured"}
      detail={`${error.code}. ${error.message}`}
    >
      A cross needs a session that reached the bell with live feeds behind it. Until one has, this
      screen shows nothing rather than a shape filled with numbers nobody could trace.
    </OwlState>
  );
}

export default async function AuctionPage({params}: {params: Promise<{auctionId: string}>}) {
  const {auctionId} = await params;
  const result = await auction(auctionId);

  if (!result.ok) {
    return (
      <div className={styles.page}>
        <Link href="/auction" className={styles.back}>
          All auctions
        </Link>
        <Unavailable auctionId={auctionId} error={result.error} />
      </div>
    );
  }

  const book = result.value;
  const imbalance = book.imbalance === null ? null : BigInt(book.imbalance);

  const settled = book.phase === "crossed" || book.phase === "aborted";
  // AuctionHouse takes commitments until the freeze and refuses them after.
  const taking = book.phase === "accumulating" || book.phase === "disclosing";
  const [now, solverless] = taking
    ? await Promise.all([active().catch(() => null), noActiveSolver()])
    : [null, false];

  return (
    <div className={styles.page}>
      <Link href="/auction" className={styles.back}>
        All auctions
      </Link>

      <Admission kind={book.provenance.source.kind} />

      <header className={styles.head}>
        <div>
          <p className={styles.eyebrow}>
            {book.kind === "close" ? "Closing cross" : "Opening cross"} . {book.token.symbol}
          </p>
          <h1 className={styles.title}>
            {book.result === null
              ? "Not crossed yet"
              : `${amount(book.result.price, 18, 4)} per ${book.token.symbol}`}
          </h1>
          <p className={styles.phase}>{PHASE_COPY[book.phase]}</p>
        </div>
      </header>

      <div className={styles.grid}>
        <div className={styles.card}>
          <p className={styles.label}>
            Indicative price
            <Hint label="What the indicative price is">
              The clearing price the contract would pick from its book right now. It is published
              while the book is still open, so it can be acted on.
            </Hint>
          </p>
          <p className={`${styles.value} chainvalue`}>
            {book.indicativePrice === null ? "closed" : amount(book.indicativePrice, 18, 4)}
          </p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>
            Imbalance
            <Hint label="What the imbalance is">
              Which side is short and by how much, named before the cross rather than after. It is
              an open invitation to whoever can fill it.
            </Hint>
          </p>
          <p className={`${styles.value} chainvalue`}>
            {imbalance === null
              ? "closed"
              : `${imbalance > 0n ? "buy" : "sell"} ${amount(
                  (imbalance < 0n ? -imbalance : imbalance).toString(),
                  book.token.decimals,
                  4,
                )}`}
          </p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>
            Participants
            <Hint label="Who counts as a participant">
              Distinct owners with a commitment in this book. One owner with several commitments
              counts once.
            </Hint>
          </p>
          <p className={`${styles.value} chainvalue`}>{book.participantCount}</p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>
            Collar
            <Hint label="What the collar is">
              How far the cross may sit from the reference price. It widens when the book cannot
              clear inside it. Extensions so far: {book.extensions}.
            </Hint>
          </p>
          <p className={`${styles.value} chainvalue`}>{book.collarBps} bps</p>
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
                <Seal state={book.result.sufficient ? "pass" : "fail"} size={16} />{" "}
                {book.result.sufficient ? "yes, the print was issued" : "no, nothing was printed"}
              </strong>
            </div>
          </div>
        </section>
      )}

      {/* On a fork the book is the demo harness's five intents, and a sixth stops its cross. */}
      {/* A cross needs an active solver, and without one a commitment would sit in escrow until the abort. */}
      {now === null || now.network.kind === "fork" ? null : solverless ? (
        <p className={styles.hint}>
          No solver is bonded on this chain yet, so nothing would cross this auction. Commitments open
          once one is.
        </p>
      ) : (
        <CommitCard
          chainId={now.network.chainId}
          auctionHouse={now.contracts.auctionHouse}
          permit2={now.contracts.permit2}
          token={{symbol: book.token.symbol, address: book.token.address, decimals: book.token.decimals}}
          quote={{symbol: now.quote.symbol, address: now.quote.address, decimals: now.quote.decimals}}
          cross={book.kind}
          crossAt={book.crossAt}
        />
      )}

      <AuctionLive settled={settled} />

      <p className={styles.sectionLabel}>Provenance</p>
      <ProvenanceStrip at={book.provenance} />
    </div>
  );
}
