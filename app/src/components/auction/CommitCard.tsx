"use client";

import {useRouter} from "next/navigation";
import {useState} from "react";
import {
  BaseError,
  ContractFunctionRevertedError,
  erc20Abi,
  formatUnits,
  maxUint256,
  parseUnits,
  type Address,
} from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContracts,
  useSignTypedData,
  useWalletClient,
  useWriteContract,
} from "wagmi";
import {auctionHouseAbi} from "@/lib/abi";
import {nextNonce} from "@/lib/coordinator/client";
import {buildAuctionIntent} from "@/lib/intent";
import {permit2Domain, permitWitnessMessage, PERMIT2_WITNESS_TYPES} from "@/lib/permit2";
import {walletSeesSameChain} from "@/lib/wallet-guard";
import styles from "./CommitCard.module.css";

type Token = {symbol: string; address: Address; decimals: number};

type Props = {
  chainId: number;
  auctionHouse: Address;
  permit2: Address;
  token: Token;
  quote: Token;
  cross: "open" | "close";
  crossAt: number;
};

type Side = "sell" | "buy";

/* The name the contract gave its refusal, which says more than a wallet summary. */
function reason(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((inner) => inner instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? reverted.reason;
      if (name) return `AuctionHouse refused. ${name}`;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? (error.message.split("\n")[0] ?? "Failed") : "Failed";
}

/*
 * A commitment is a transaction, unlike a batch intent, which is only a signature
 * handed to the coordinator. The person signs the Permit2 witness with AuctionHouse
 * as the spender, then sends it themselves. Nothing is pulled until the freeze.
 */
export function CommitCard({chainId, auctionHouse, permit2, token, quote, cross, crossAt}: Props) {
  const router = useRouter();
  const chain = chainId as 4663 | 46630;
  const {address, isConnected, chainId: walletChain} = useAccount();
  const client = usePublicClient({chainId: chain});
  const {signTypedDataAsync} = useSignTypedData();
  const {data: wallet} = useWalletClient();
  const {writeContractAsync} = useWriteContract();

  /*
   * Asked before every transaction this card sends. The wallet sends through its
   * own endpoint, and on a fork that endpoint has to be the fork, or the approval
   * and the commitment land on the real chain.
   */
  async function sameChain(): Promise<boolean> {
    if (client === undefined || wallet === undefined) {
      setNote("Your wallet is not ready. Reconnect it and try again");
      return false;
    }
    const guard = await walletSeesSameChain(wallet as never, await client.getBlockNumber({cacheTime: 0}));
    if (!guard.ok) setNote(guard.reason);
    return guard.ok;
  }

  const [side, setSide] = useState<Side>("sell");
  const [amount, setAmount] = useState("");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const pays = side === "sell" ? token : quote;
  const gets = side === "sell" ? quote : token;
  const holder = address ?? auctionHouse;

  const {data: held, refetch} = useReadContracts({
    contracts: [
      {address: pays.address, abi: erc20Abi, functionName: "balanceOf", args: [holder], chainId: chain},
      {
        address: pays.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [holder, permit2],
        chainId: chain,
      },
    ],
    query: {enabled: address !== undefined},
  });
  const balance = held?.[0]?.result as bigint | undefined;
  const allowance = held?.[1]?.result as bigint | undefined;

  let sellAmount: bigint | null = null;
  let minBuyAmount: bigint | null = 0n;
  try {
    sellAmount = amount.trim() === "" ? null : parseUnits(amount, pays.decimals);
    if (limit.trim() !== "" && sellAmount !== null) {
      // The limit is quote per whole token, so it multiplies a sale and divides a purchase.
      const price = parseUnits(limit, quote.decimals);
      const one = 10n ** BigInt(token.decimals);
      minBuyAmount =
        price === 0n ? null : side === "sell" ? (sellAmount * price) / one : (sellAmount * one) / price;
    }
  } catch {
    sellAmount = null;
    minBuyAmount = null;
  }

  const wrongChain = isConnected && walletChain !== chainId;
  const short = sellAmount !== null && balance !== undefined && balance < sellAmount;
  const unapproved = sellAmount !== null && allowance !== undefined && allowance < sellAmount;

  async function approve() {
    if (address === undefined) return;
    setNote(null);
    if (!(await sameChain())) return;
    setBusy("Approve in your wallet");
    try {
      const hash = await writeContractAsync({
        address: pays.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [permit2, maxUint256],
        chainId: chain,
      });
      setBusy("Waiting for the approval to land");
      await client?.waitForTransactionReceipt({hash});
      await refetch();
    } catch (error) {
      setNote(reason(error));
    }
    setBusy(null);
  }

  async function commit() {
    if (address === undefined || sellAmount === null || minBuyAmount === null || client === undefined) {
      return;
    }
    setNote(null);
    setSent(null);
    if (!(await sameChain())) return;

    // Permit2 takes any nonce not yet spent. The coordinator knows which those are,
    // and the clock is a fair stand in when there is no coordinator to ask.
    const asked = await nextNonce(address);
    const nonce = asked.ok ? BigInt(asked.value.next) : BigInt(Date.now());

    const intent = buildAuctionIntent({
      owner: address,
      sellToken: pays.address,
      buyToken: gets.address,
      sellAmount,
      minBuyAmount,
      cross,
      crossAt,
      nonce,
    });

    try {
      setBusy("Sign the commitment in your wallet");
      const signature = await signTypedDataAsync({
        domain: permit2Domain(chainId, permit2),
        types: PERMIT2_WITNESS_TYPES,
        primaryType: "PermitWitnessTransferFrom",
        message: permitWitnessMessage(intent, auctionHouse),
      });

      // Asked first without sending, so a refusal costs no gas and arrives with
      // the name the contract gave it.
      await client.simulateContract({
        address: auctionHouse,
        abi: auctionHouseAbi,
        functionName: "commitAuctionIntent",
        args: [intent, signature],
        account: address,
      });

      setBusy("Send the commitment from your wallet");
      const hash = await writeContractAsync({
        address: auctionHouse,
        abi: auctionHouseAbi,
        functionName: "commitAuctionIntent",
        args: [intent, signature],
        chainId: chain,
      });
      setBusy("Waiting for the commitment to land");
      await client.waitForTransactionReceipt({hash});
      setSent(hash);
      setAmount("");
      router.refresh();
    } catch (error) {
      setNote(reason(error));
    }
    setBusy(null);
  }

  const label = !isConnected
    ? "Connect a wallet to commit"
    : wrongChain
      ? "Switch network in the wallet card"
      : sellAmount === null || sellAmount === 0n
        ? "Enter an amount"
        : minBuyAmount === null
          ? "Enter a limit above zero"
          : short
            ? `Not enough ${pays.symbol}`
            : unapproved
              ? `Approve ${pays.symbol} for Permit2`
              : "Commit to this cross";

  const ready =
    isConnected &&
    !wrongChain &&
    sellAmount !== null &&
    sellAmount > 0n &&
    minBuyAmount !== null &&
    !short &&
    busy === null;

  return (
    <section className={styles.card}>
      <p className={styles.title}>Commit to this cross</p>

      <div className={styles.sides}>
        {(["sell", "buy"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={`${styles.side} ${side === option ? styles.sideActive : ""}`}
            onClick={() => setSide(option)}
          >
            {option === "sell" ? `Sell ${token.symbol}` : `Buy ${token.symbol}`}
          </button>
        ))}
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>
          You pay, in {pays.symbol}
          {balance === undefined ? null : (
            <span className="chainvalue"> . you hold {formatUnits(balance, pays.decimals)}</span>
          )}
        </span>
        <input
          className={`${styles.input} chainvalue`}
          inputMode="decimal"
          placeholder="0"
          value={amount}
          onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>
          Limit, in {quote.symbol} per {token.symbol}. Leave empty to take the clearing price
        </span>
        <input
          className={`${styles.input} chainvalue`}
          inputMode="decimal"
          placeholder="no limit"
          value={limit}
          onChange={(event) => setLimit(event.target.value.replace(/[^0-9.]/g, ""))}
        />
      </label>

      <button type="button" className={styles.action} disabled={!ready} onClick={unapproved ? approve : commit}>
        {busy ?? label}
      </button>

      {note === null ? null : <p className={styles.note}>{note}</p>}
      {sent === null ? null : (
        <p className={styles.sent}>
          Committed. Nothing has moved, and nothing does until the freeze.
          <span className={`${styles.hash} chainvalue`}>{sent}</span>
        </p>
      )}
    </section>
  );
}
