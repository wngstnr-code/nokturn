"use client";

import {useQueryClient} from "@tanstack/react-query";
import {useState} from "react";
import {formatUnits} from "viem";
import {useAccount} from "wagmi";
import {faucet} from "@/lib/coordinator/client";
import type {ApiError, FaucetResponse} from "@/lib/coordinator/types";
import {explorerTx} from "@/lib/chain";
import type {TokenInfo} from "@/lib/tokens";
import styles from "./TestTokens.module.css";

const OFFICIAL_FAUCET = "https://faucet.testnet.chain.robinhood.com";

type State =
  | {kind: "idle"}
  | {kind: "busy"}
  | {kind: "done"; answer: FaucetResponse}
  | {kind: "failed"; error: ApiError};

function amount(raw: string, decimals: number): string {
  try {
    return Number(formatUnits(BigInt(raw), decimals)).toLocaleString("en-US", {maximumFractionDigits: 4});
  } catch {
    return raw;
  }
}

function minutes(seconds: unknown): string | null {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  const whole = Math.ceil(value / 60);
  return whole === 1 ? "a minute" : `${whole} minutes`;
}

/*
 * The faucet sends from its own key, gas included, so a judge with an empty
 * wallet can start here. Nothing is signed and nothing is paid from the wallet.
 */
export function TestTokens({chainId, tokens}: {chainId: number; tokens: TokenInfo[]}) {
  const {address} = useAccount();
  const queryClient = useQueryClient();
  const [state, setState] = useState<State>({kind: "idle"});

  if (address === undefined) return null;

  const decimalsOf = new Map(tokens.map((token) => [token.address.toLowerCase(), token.decimals]));
  const decimals = (token: string | null) => (token === null ? 18 : (decimalsOf.get(token.toLowerCase()) ?? 18));

  async function ask() {
    if (address === undefined) return;
    setState({kind: "busy"});
    const result = await faucet(address);
    if (!result.ok) {
      setState({kind: "failed", error: result.error});
      return;
    }
    setState({kind: "done", answer: result.value});
    // The card reads balances and the Permit2 allowance through the same cache.
    await queryClient.invalidateQueries();
  }

  const outOfGas = state.kind === "failed" && state.error.detail?.faucet !== undefined;
  const wait = state.kind === "failed" && state.error.code === "COORDINATOR_RATE_LIMITED"
    ? minutes(state.error.detail?.retryAfterSeconds)
    : null;

  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <div>
          <p className={styles.title}>Test tokens</p>
          <p className={styles.body}>
            Tops this wallet up with every test token and a little testnet ETH for gas. Nothing is
            signed or paid from your wallet.
          </p>
        </div>
        <button
          type="button"
          className={styles.button}
          onClick={() => void ask()}
          disabled={state.kind === "busy"}
        >
          {state.kind === "busy" ? "Sending" : "Get test tokens"}
        </button>
      </div>

      {state.kind === "busy" ? (
        <p className={styles.note}>Each transfer is sent and confirmed before this answers.</p>
      ) : null}

      {state.kind === "done" ? (
        <ul className={styles.list}>
          {state.answer.sent.map((row) => (
            <li key={row.tx} className={styles.row}>
              <span className="chainvalue">
                {amount(row.amount, decimals(row.token))} {row.symbol}
              </span>
              <a className="chainvalue" href={explorerTx(row.tx, chainId)} target="_blank" rel="noreferrer">
                {`${row.tx.slice(0, 10)}…`}
              </a>
            </li>
          ))}
          {state.answer.skipped.map((row) => (
            <li key={row.symbol} className={`${styles.row} ${styles.skipped}`}>
              <span>{row.symbol}</span>
              <span>already held</span>
            </li>
          ))}
        </ul>
      ) : null}

      {state.kind === "failed" ? (
        <p className={styles.error}>
          {wait !== null
            ? `This wallet asked recently. Try again in ${wait}.`
            : outOfGas
              ? "The faucet has run out of testnet ETH."
              : state.error.message}
          {outOfGas || wait === null ? (
            <>
              {" "}
              Testnet ETH is also on the{" "}
              <a href={OFFICIAL_FAUCET} target="_blank" rel="noreferrer">
                Robinhood Chain faucet
              </a>
              .
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
