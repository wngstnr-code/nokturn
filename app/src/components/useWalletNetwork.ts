"use client";

import {useEffect, useState} from "react";
import {usePublicClient, useWalletClient} from "wagmi";
import {walletSeesSameChain} from "@/lib/wallet-guard";

const RECHECK_MS = 20_000;

export type WalletNetwork =
  | {state: "unknown"}
  | {state: "same"}
  | {state: "other"; walletHead: bigint | null; appHead: bigint};

/*
 * Whether the wallet is reading the same network this app is, asked as soon as it
 * connects rather than when a transaction is about to be sent. A fork and the
 * chain it was forked from share a chain id, so a wallet pointed at one while the
 * app reads the other looks correct to every check that only compares ids. The
 * person finds out at the last step, which is the worst place to find out.
 */
export function useWalletNetwork(chainId: number, enabled: boolean): WalletNetwork {
  const client = usePublicClient({chainId: chainId as 4663 | 46630});
  const {data: wallet} = useWalletClient();
  const [answer, setAnswer] = useState<WalletNetwork>({state: "unknown"});

  useEffect(() => {
    if (!enabled || client === undefined || wallet === undefined) {
      setAnswer({state: "unknown"});
      return;
    }

    let alive = true;
    const check = async () => {
      try {
        const head = await client.getBlockNumber({cacheTime: 0});
        const guard = await walletSeesSameChain(wallet as never, head);
        if (!alive) return;
        setAnswer(
          guard.ok
            ? {state: "same"}
            : {state: "other", walletHead: guard.walletHead, appHead: guard.appHead},
        );
      } catch {
        // The app's own endpoint not answering says nothing about the wallet.
        if (alive) setAnswer({state: "unknown"});
      }
    };

    void check();
    const timer = setInterval(() => void check(), RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, wallet, enabled]);

  return answer;
}
