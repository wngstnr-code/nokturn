"use client";

import Link from "next/link";
import {useEffect, useMemo, useState} from "react";
import {erc20Abi, formatUnits, parseUnits, type Address} from "viem";
import {useAccount, useReadContract, useSignTypedData} from "wagmi";
import {Button} from "@/components/ui/Button";
import {TokenSelect} from "./TokenSelect";
import {useIntents} from "./IntentsProvider";
import {StartCard} from "./StartCard";
import {buildIntent, serializeIntent} from "@/lib/intent";
import {permit2Domain, permitWitnessMessage, PERMIT2_WITNESS_TYPES} from "@/lib/permit2";
import {currentBatch, nextNonce, quote as fetchBaseline, submitIntent} from "@/lib/coordinator/client";
import type {BaselineQuote} from "@/lib/coordinator/types";
import {units} from "@/lib/format";
import type {TokenInfo} from "@/lib/tokens";
import {IntentKind} from "@shared/types";
import styles from "./TradeWidget.module.css";

type Mode = "spot" | "auction";

export type TradeContext = {
  chainId: number;
  settlement: Address;
  permit2: Address;
  signingOk: boolean;
  signingProblem: string | null;
  sessionName: string;
  batchDuration: number;
  maxDeviationBps: number;
  coordinatorDetail: string;
  coordinatorReachable: boolean;
};

interface TradeWidgetProps {
  bases: TokenInfo[];
  quote: TokenInfo;
  context: TradeContext;
}

const VALID_FOR_SECONDS = 15 * 60;

export function TradeWidget({bases, quote, context}: TradeWidgetProps) {
  const [mode, setMode] = useState<Mode>("spot");
  const [sellToken, setSellToken] = useState<TokenInfo | undefined>(bases[0]);
  const [amount, setAmount] = useState("");
  const [tolerance, setTolerance] = useState(50);
  const [partialFill, setPartialFill] = useState(true);
  const [signature, setSignature] = useState<`0x${string}` | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<BaselineQuote | null>(null);
  const [quoting, setQuoting] = useState(false);

  const {remember} = useIntents();
  const {address, isConnected, chainId} = useAccount();
  const {signTypedDataAsync, isPending} = useSignTypedData();

  const {data: balance} = useReadContract({
    address: sellToken?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: {enabled: Boolean(address && sellToken)},
  });

  const sellAmount = useMemo(() => {
    if (sellToken === undefined || amount.trim() === "") return null;
    try {
      const parsed = parseUnits(amount, sellToken.decimals);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [amount, sellToken]);

  useEffect(() => {
    if (sellAmount === null || sellToken === undefined) {
      setBaseline(null);
      setQuoting(false);
      return;
    }

    let live = true;
    setQuoting(true);

    const timer = setTimeout(async () => {
      const result = await fetchBaseline({
        sellToken: sellToken.address,
        buyToken: quote.address,
        sellAmount: sellAmount.toString(),
      });
      if (!live) return;
      setBaseline(result.ok ? result.value : null);
      setQuoting(false);
    }, 400);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sellAmount, sellToken, quote.address]);

  /// Only a baseline the adapter actually answered is treated as a number.
  const estimate = baseline !== null && baseline.unavailable === null ? baseline : null;

  const rate = useMemo(() => {
    if (estimate === null || sellToken === undefined || sellAmount === null || sellAmount === 0n) {
      return null;
    }
    const sold = Number(formatUnits(sellAmount, sellToken.decimals));
    const got = Number(formatUnits(BigInt(estimate.baselineBuy), estimate.buyDecimals));
    if (!Number.isFinite(sold) || sold === 0 || !Number.isFinite(got)) return null;
    return (got / sold).toLocaleString("en-US", {maximumFractionDigits: 6});
  }, [estimate, sellAmount, sellToken]);

  const wrongChain = isConnected && chainId !== context.chainId;
  const canSign =
    isConnected && !wrongChain && context.signingOk && sellAmount !== null && sellToken !== undefined;

  async function sign() {
    if (!canSign || address === undefined || sellToken === undefined || sellAmount === null) return;
    setNote(null);
    setSignature(null);

    // Both are facts the chain owns. Guessing either is refused later.
    const [batch, nonce] = await Promise.all([currentBatch(), nextNonce(address)]);
    if (!batch.ok) {
      setNote(`${batch.error.code}. ${batch.error.message}`);
      return;
    }
    if (batch.value.batchId === null) {
      setNote(`No batch is open right now (${batch.value.reason ?? "unknown"}). Nothing to join yet.`);
      return;
    }
    if (!nonce.ok) {
      setNote(`${nonce.error.code}. ${nonce.error.message}`);
      return;
    }

    const intent = buildIntent({
      owner: address,
      sellToken: sellToken.address,
      buyToken: quote.address,
      sellAmount,
      // The batch clears at one price, so the tolerance is the binding limit.
      minBuyAmount: 0n,
      toleranceBps: tolerance,
      partialFill,
      kind: mode === "spot" ? IntentKind.SPOT : IntentKind.ROO,
      nonce: BigInt(nonce.value.next),
      chainTime: batch.value.chainTime,
      collectEndsAt: batch.value.collectEndsAt,
      validForSeconds: VALID_FOR_SECONDS,
      batchSpan: 1,
    });

    try {
      // Permit2 witness, not a bare Intent. The only digest anything verifies.
      const signed = await signTypedDataAsync({
        domain: permit2Domain(context.chainId, context.permit2),
        types: PERMIT2_WITNESS_TYPES,
        primaryType: "PermitWitnessTransferFrom",
        message: permitWitnessMessage(intent, context.settlement),
      });
      setSignature(signed);

      const result = await submitIntent({intent: serializeIntent(intent), signature: signed});
      if (result.ok) {
        remember({
          hash: result.value.intentHash,
          sentAt: Date.now(),
          sold: `${formatUnits(sellAmount, sellToken.decimals)} ${sellToken.symbol}`,
          buySymbol: quote.symbol,
        });
        setNote(`Accepted into batch ${result.value.batchId}. Collection closes at ${result.value.collectEndsAt}`);
      } else {
        setNote(`${result.error.code}. ${result.error.message}`);
      }
    } catch (error) {
      setNote(
        error instanceof Error
          ? (error.message.split("\n")[0] ?? "Signing failed")
          : "Signing failed",
      );
    }
  }

  const balanceLabel =
    balance === undefined || sellToken === undefined
      ? null
      : Number(formatUnits(balance, sellToken.decimals)).toLocaleString("en-US", {
          maximumFractionDigits: 4,
        });

  const action = !isConnected
    ? "Connect a wallet to sign"
    : wrongChain
      ? "Wrong network"
      : !context.signingOk
        ? "Signing is disabled"
        : sellAmount === null
          ? "Enter an amount"
          : isPending
            ? "Waiting for your wallet"
            : "Sign intent";

  return (
    <div className={styles.container}>
      <div className={styles.box}>
        {!isConnected ? (
          <StartCard bases={bases} />
        ) : (
          <>
            <div className={styles.head}>
              <div className={styles.tabs}>
                <button
                  type="button"
                  className={`${styles.tab} ${mode === "spot" ? styles.tabActive : ""}`}
                  onClick={() => setMode("spot")}
                >
                  Spot
                </button>
                <button
                  type="button"
                  className={`${styles.tab} ${mode === "auction" ? styles.tabActive : ""}`}
                  onClick={() => setMode("auction")}
                >
                  Auction
                </button>
              </div>
              <Link className={styles.headRight} href="/session">
                {context.sessionName}
              </Link>
            </div>

          <label className={styles.panel}>
            <div className={styles.topRow}>
              <span className={styles.topLabel}>Sell</span>
            </div>
            <div className={styles.inputRow}>
              <input
                className={styles.input}
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(event) => {
                  setSignature(null);
                  setNote(null);
                  setAmount(event.target.value.replace(/[^0-9.]/g, ""));
                }}
              />
              {sellToken === undefined ? null : (
                <TokenSelect token={sellToken} options={bases} onSelect={setSellToken} />
              )}
            </div>
            {balanceLabel === null || sellToken === undefined ? null : (
              <div className={styles.inputRow}>
                <span />
                <span className={styles.balance}>
                  Balance <span className="chainvalue">{balanceLabel}</span>
                  <button
                    type="button"
                    className={styles.maxButton}
                    onClick={() => balance !== undefined && setAmount(formatUnits(balance, sellToken.decimals))}
                  >
                    Max
                  </button>
                </span>
              </div>
            )}
          </label>

          <div className={styles.separator}>
            <div className={styles.separatorPuck} aria-hidden="true">
              &#8595;
            </div>
          </div>

          <div className={`${styles.panel} ${styles.panelReadonly}`}>
            <div className={styles.topRow}>
              <span className={styles.topLabel}>Receive</span>
              <span className={styles.topNote}>at the price the batch clears at</span>
            </div>
            <div className={styles.inputRow}>
              <span className={styles.settledNote}>
                {sellAmount === null
                  ? "Enter an amount"
                  : quoting
                    ? "Reading the venue"
                    : baseline === null
                      ? "No estimate available"
                      : baseline.unavailable !== null
                        ? "The venue could not answer"
                        : units(BigInt(baseline.baselineBuy), baseline.buyDecimals, 4)}
              </span>
              <TokenSelect token={quote} />
            </div>
            {estimate === null ? null : (
              <div className={styles.estimateRow}>
                <span className={styles.estimate}>
                  About this much if you went to the venue alone, at block{" "}
                  <span className="chainvalue">{estimate.provenance.blockNumber}</span>. A batch can
                  only beat it.
                </span>
              </div>
            )}
          </div>

          {rate === null || sellToken === undefined ? null : (
            <div className={styles.rateRow}>
              <span className={styles.rateLabel}>Venue rate now</span>
              <span className={`${styles.rateValue} chainvalue`}>
                1 {sellToken.symbol} = {rate} {quote.symbol}
              </span>
            </div>
          )}

          <div className={styles.rows}>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Batch window</span>
              <span className={`${styles.rowValue} chainvalue`}>
                {context.batchDuration === 0 ? "auction" : `${context.batchDuration}s`}
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Session price band</span>
              <span className={`${styles.rowValue} chainvalue`}>{context.maxDeviationBps} bps</span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Your tolerance</span>
              <span className={styles.rowValue}>
                <input
                  className={`${styles.toleranceInput} chainvalue`}
                  inputMode="numeric"
                  value={tolerance}
                  onChange={(event) => setTolerance(Number(event.target.value.replace(/\D/g, "")) || 0)}
                />
                {" bps"}
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Partial fill</span>
              <button type="button" className={styles.toggle} onClick={() => setPartialFill((on) => !on)}>
                <span className={`${styles.switch} ${partialFill ? styles.switchOn : ""}`}>
                  <span className={styles.knob} />
                </span>
                {partialFill ? "Allowed" : "All or nothing"}
              </button>
            </div>
          </div>

          {signature === null ? null : (
            <div className={styles.signed}>
              Intent signed. Nothing moved and no transaction was sent.
              <span className={`${styles.signedValue} chainvalue`}>{signature}</span>
            </div>
          )}

          {note === null ? null : <div className={styles.notice}>{note}</div>}

          {context.signingOk ? null : (
            <div className={styles.notice}>
              {context.signingProblem ?? "The signing context could not be read from the chain."}
            </div>
          )}

          {context.coordinatorReachable ? null : (
            <div className={`${styles.notice} ${styles.noticeInfo}`}>{context.coordinatorDetail}</div>
          )}

            <Button disabled={!canSign || isPending} onClick={sign}>
              {action}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
