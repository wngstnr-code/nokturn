/*
 * A wallet sends a transaction through its own endpoint, not through the one this
 * app reads from. Against a fork that matters a great deal. The fork carries
 * chain id 4663, the same as mainnet, so a wallet still on its default endpoint
 * agrees it is on the right chain and then sends the transaction to the real one,
 * from the person's real address, with real gas.
 *
 * The chain id cannot tell the two apart, but the head can. A fork stands at the
 * block it was pinned at and mainnet is millions of blocks past it. Two endpoints
 * on the same live chain differ by seconds.
 */

/// A minute of blocks at this chain's pace, the slack two honest endpoints may show.
const SLACK_BLOCKS = 600n;

type Asks = {request: (args: {method: "eth_blockNumber"}) => Promise<unknown>};

export type GuardAnswer =
  | {ok: true}
  | {ok: false; reason: string; walletHead: bigint | null; appHead: bigint};

export async function walletSeesSameChain(wallet: Asks, appHead: bigint): Promise<GuardAnswer> {
  let walletHead: bigint;
  try {
    walletHead = BigInt((await wallet.request({method: "eth_blockNumber"})) as string);
  } catch {
    return {
      ok: false,
      reason: "Your wallet did not say which block it is on, so nothing was sent",
      walletHead: null,
      appHead,
    };
  }

  const gap = walletHead > appHead ? walletHead - appHead : appHead - walletHead;
  if (gap <= SLACK_BLOCKS) return {ok: true};

  return {
    ok: false,
    walletHead,
    appHead,
    reason: `Nothing was sent. Your wallet is at block ${walletHead.toString()} and this app is reading block ${appHead.toString()}, so they are not on the same network. Point the wallet's RPC for this chain at the one the app uses, then try again`,
  };
}
