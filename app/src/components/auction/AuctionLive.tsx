"use client";

import {useRouter} from "next/navigation";
import {useEffect, useState} from "react";
import {watchAuctions} from "@/lib/coordinator/stream";
import styles from "./AuctionLive.module.css";

const POLL_MS = 15_000;

/*
 * The stream only says that a book moved. The figures on the page come from a
 * fresh read of the route, which names the block it read at, so nothing shown was
 * taken off the socket.
 */
export function AuctionLive({settled}: {settled: boolean}) {
  const router = useRouter();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (settled) return;
    const stop = watchAuctions(
      () => router.refresh(),
      (state) => setLive(state.live),
    );
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [router, settled]);

  if (settled) return null;

  return (
    <p className={styles.live}>
      {live
        ? "Following the stream. The page reads again whenever the book moves"
        : `Reading again every ${POLL_MS / 1000} seconds`}
    </p>
  );
}
