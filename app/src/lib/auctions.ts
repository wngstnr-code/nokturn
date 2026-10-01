import {auctionHouseAbi} from "./abi";
import {clientFor} from "./chain";
import {auction} from "./coordinator/client";
import type {AuctionResponse} from "./coordinator/types";
import {active, type Network} from "./network";
import type {Address} from "viem";
import {Session} from "@shared/types";

/// AuctionHouse numbers its auctions from one, in the order they were opened.
const SHOWN = 12;

export type AuctionList = {
  network: Network;
  auctionHouse: Address;
  blockNumber: bigint;
  /// How many AuctionHouse says it has ever opened.
  count: number;
  /// Newest first. An id the coordinator could not describe is left out and counted.
  books: AuctionResponse[];
  unreadable: number;
};

/*
 * The coordinator serves one auction by id and has no list. The contract keeps the
 * count, so the ids come from the chain and each book from the coordinator, which
 * means nothing here is a number this app made up.
 */
export async function listAuctions(): Promise<AuctionList> {
  const {network, contracts} = await active();
  const client = clientFor(network.chainId);
  const blockNumber = await client.getBlockNumber();

  const count = Number(
    await client.readContract({
      address: contracts.auctionHouse,
      abi: auctionHouseAbi,
      functionName: "auctionCount",
      blockNumber,
    }),
  );

  const ids: number[] = [];
  for (let id = count; id >= 1 && ids.length < SHOWN; id -= 1) ids.push(id);

  const answers = await Promise.all(ids.map((id) => auction(String(id))));
  const books = answers.flatMap((answer) => (answer.ok ? [answer.value] : []));

  return {
    network,
    auctionHouse: contracts.auctionHouse,
    blockNumber,
    count,
    books,
    unreadable: answers.length - books.length,
  };
}

const KIND_OPEN = 0;
const KIND_CLOSE = 1;

/// CivilDate.toYmd on the UTC date of a timestamp, which is how AuctionHouse keys a day.
function ymdOf(timestamp: number): number {
  const date = new Date(timestamp * 1000);
  return date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

/*
 * The auction each token has open in the session the chain is in right now, asked
 * the way the keeper asks, auctionIdOf(token, day, kind), so this app and the
 * keeper name the same book. A token whose answer is zero has no auction and gets
 * no entry, so nothing can link to a book that was never opened.
 */
export async function openAuctionIds(
  chainId: number,
  auctionHouse: Address,
  tokens: readonly Address[],
  session: Session,
  nextTransition: number,
): Promise<Record<string, string>> {
  const kind =
    session === Session.AUCTION_OPEN ? KIND_OPEN : session === Session.AUCTION_CLOSE ? KIND_CLOSE : null;
  if (kind === null || tokens.length === 0) return {};

  const client = clientFor(chainId);
  const day = ymdOf(nextTransition);
  const found: Record<string, string> = {};

  await Promise.all(
    tokens.map(async (token) => {
      try {
        const id = (await client.readContract({
          address: auctionHouse,
          abi: auctionHouseAbi,
          functionName: "auctionIdOf",
          args: [token, day, kind],
        })) as bigint;
        if (id !== 0n) found[token] = id.toString();
      } catch {
        // One token that cannot be asked leaves the others standing.
      }
    }),
  );

  return found;
}
