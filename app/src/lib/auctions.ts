import {auctionHouseAbi} from "./abi";
import {clientFor} from "./chain";
import {auction} from "./coordinator/client";
import type {AuctionResponse} from "./coordinator/types";
import {active, type Network} from "./network";
import type {Address} from "viem";

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
