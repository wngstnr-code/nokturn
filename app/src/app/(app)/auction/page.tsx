import Link from "next/link";
import {Admission} from "@/components/auction/Admission";
import {BellIcon} from "@/components/Icons";
import {OwlState} from "@/components/ui/OwlState";
import {AuctionLive} from "@/components/auction/AuctionLive";
import {explorerAddress} from "@/lib/chain";
import {listAuctions, type AuctionList} from "@/lib/auctions";
import type {AuctionResponse} from "@/lib/coordinator/types";
import {units} from "@/lib/format";
// Same list geometry as the batch screen, so the two read as one family.
import styles from "../batch/page.module.css";

export const metadata = {title: "Auctions"};

export const dynamic = "force-dynamic";

const PHASE: Record<AuctionResponse["phase"], string> = {
  accumulating: "Taking commitments",
  disclosing: "Open, publishing its imbalance",
  frozen: "Frozen, waiting for the bell",
  crossed: "Crossed",
  aborted: "Abandoned",
};

function price(value: string | null): string {
  if (value === null) return "not published";
  try {
    return units(BigInt(value), 18, 4);
  } catch {
    return "unreadable";
  }
}

function Row({book}: {book: AuctionResponse}) {
  return (
    <Link href={`/auction/${book.auctionId}`} className={styles.row}>
      <div className={styles.lead}>
        <span className={styles.rowMark} aria-hidden="true">
          <BellIcon size={18} />
        </span>
        <div className={styles.cell}>
          {book.kind === "close" ? "Closing cross" : "Opening cross"}
          <strong>
            {book.token.symbol} <span className="chainvalue">#{book.auctionId}</span>
          </strong>
        </div>
      </div>
      <div className={styles.cell}>
        Phase
        <strong>{PHASE[book.phase]}</strong>
      </div>
      <div className={styles.cell}>
        {book.result === null ? "Indicative price" : "Print"}
        <strong className="chainvalue">
          {book.result === null ? price(book.indicativePrice) : price(book.result.price)}
        </strong>
      </div>
      <div className={styles.cell}>
        Participants
        <strong className="chainvalue">{book.participantCount}</strong>
      </div>
    </Link>
  );
}

function Empty({list}: {list: AuctionList}) {
  return (
    <OwlState
      mood="waiting"
      title="No auction has opened on this chain"
      detail={`auctionCount() returned ${list.count} at block ${list.blockNumber.toString()} on chain ${list.network.chainId}`}
    >
      AuctionHouse opens a book only inside an opening or a closing session. Nothing is drawn here
      until it has opened one.
    </OwlState>
  );
}

export default async function AuctionsPage() {
  let list: AuctionList | null = null;
  let failure: string | null = null;

  try {
    list = await listAuctions();
  } catch (error) {
    failure = error instanceof Error ? (error.message.split("\n")[0] ?? "read failed") : "read failed";
  }

  const settled =
    list !== null && list.books.every((book) => book.phase === "crossed" || book.phase === "aborted");

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <p className={styles.eyebrow}>Auctions</p>
          <h1 className={styles.title}>The imbalance is published before the cross</h1>
        </div>
        {list === null ? null : (
          <p className={styles.window}>
            AuctionHouse
            <strong>
              <a
                className="chainvalue"
                href={explorerAddress(list.auctionHouse, list.network.chainId)}
                target="_blank"
                rel="noreferrer"
              >
                {list.auctionHouse.slice(0, 10)}
              </a>
            </strong>
          </p>
        )}
      </div>

      {failure !== null ? (
        <OwlState mood="asleep" title="The chain did not answer" detail={failure}>
          Nothing is shown rather than something invented.
        </OwlState>
      ) : null}

      {list === null ? null : (
        <>
          {list.books.length > 0 ? <Admission kind={list.network.kind} /> : null}

          {list.count === 0 ? (
            <Empty list={list} />
          ) : (
            <div className={styles.rows}>
              {list.books.map((book) => (
                <Row key={book.auctionId} book={book} />
              ))}
              {list.unreadable > 0 ? (
                <p className={styles.more}>
                  {list.unreadable} of the newest auctions could not be read from the coordinator
                </p>
              ) : null}
              {list.count > list.books.length + list.unreadable ? (
                <p className={styles.more}>
                  AuctionHouse has opened {list.count} in all. The newest are shown
                </p>
              ) : null}
            </div>
          )}

          <AuctionLive settled={list.count > 0 && settled} />
        </>
      )}
    </div>
  );
}
