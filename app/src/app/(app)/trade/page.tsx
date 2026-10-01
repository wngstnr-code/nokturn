import {IntentsProvider} from "@/components/trade/IntentsProvider";
import {TradeLayout} from "@/components/trade/TradeLayout";
import {MyIntents} from "@/components/trade/MyIntents";
import {TradeWidget, type TradeContext} from "@/components/trade/TradeWidget";
import {openAuctionIds} from "@/lib/auctions";
import {health, session as servedSession} from "@/lib/coordinator/client";
import {deploymentFor} from "@/lib/deployments";
import {servedConfig} from "@/lib/network";
import {signingContext} from "@/lib/permit2";
import {readSession, SESSION_NAMES} from "@/lib/session";
import {baseTokens, quoteToken, type TokenInfo} from "@/lib/tokens";
import {CHAIN_ID_TESTNET} from "@shared/addresses";
import type {Session} from "@shared/types";
import styles from "./page.module.css";

export const metadata = {title: "Trade"};

export const dynamic = "force-dynamic";

const CHAIN = CHAIN_ID_TESTNET;

type Loaded = {bases: TokenInfo[]; quote: TokenInfo; context: TradeContext};

/*
 * With a coordinator, everything the card signs against comes from the chain the
 * coordinator is on. Its Settlement is the spender Permit2 binds the signature to,
 * so an address kept in this app would produce a signature it refuses.
 */
async function loadServed(served: NonNullable<Awaited<ReturnType<typeof servedConfig>>>): Promise<Loaded> {
  const {settlement, permit2} = served.contracts;
  const named = (token: {symbol: string; address: `0x${string}`; decimals: number}): TokenInfo => ({
    symbol: token.symbol,
    name: null,
    address: token.address,
    decimals: token.decimals,
  });

  const [signing, session, coordinator] = await Promise.all([
    signingContext(served.chainId, settlement, permit2),
    servedSession(),
    health(),
  ]);

  const bases = served.tokens.filter((token) => token.allowed).map(named);
  const auctions = session.ok
    ? await openAuctionIds(
        served.chainId,
        served.contracts.auctionHouse,
        bases.map((token) => token.address),
        session.value.session as Session,
        session.value.nextTransition,
      )
    : {};

  return {
    bases,
    quote: named(served.quoteToken),
    context: {
      chainId: served.chainId,
      settlement,
      permit2,
      signingOk: signing.ok,
      signingProblem: signing.problem,
      sessionName: session.ok ? SESSION_NAMES[session.value.session as Session] : null,
      batchDuration: session.ok ? session.value.batchDurationSeconds : null,
      maxDeviationBps: session.ok ? session.value.maxDeviationBps : null,
      auctions,
      coordinatorDetail: coordinator.detail,
      coordinatorReachable: coordinator.reachable,
    },
  };
}

async function loadOwn(): Promise<Loaded> {
  const deployment = deploymentFor(CHAIN);
  if (deployment === null) throw new Error(`Nokturn is not deployed on chain ${CHAIN}`);

  /*
   * The tokens are the card. Without them there is nothing to draw, so they stay
   * fatal. The session only fills three lines, and losing an endpoint for a moment
   * is not a reason to take the whole page away, so it is allowed to come back
   * empty and say so.
   */
  const [bases, quote, signing, session, coordinator] = await Promise.all([
    baseTokens(CHAIN),
    quoteToken(CHAIN),
    signingContext(CHAIN, deployment.settlement, deployment.permit2),
    readSession(CHAIN, []).catch(() => null),
    health(),
  ]);

  const auctions =
    session === null
      ? {}
      : await openAuctionIds(
          CHAIN,
          deployment.auctionHouse,
          bases.map((token) => token.address),
          session.session,
          Number(session.nextTransition),
        );

  return {
    bases,
    quote,
    context: {
      chainId: CHAIN,
      settlement: deployment.settlement,
      permit2: deployment.permit2,
      signingOk: signing.ok,
      signingProblem: signing.problem,
      sessionName: session === null ? null : SESSION_NAMES[session.session],
      batchDuration: session === null ? null : session.batchDuration,
      maxDeviationBps: session === null ? null : session.maxDeviationBps,
      auctions,
      coordinatorDetail: coordinator.detail,
      coordinatorReachable: coordinator.reachable,
    },
  };
}

async function load(): Promise<Loaded> {
  const served = await servedConfig();
  return served === null ? loadOwn() : loadServed(served);
}

export default async function TradePage() {
  let loaded: Loaded | null = null;
  let failure: string | null = null;

  try {
    loaded = await load();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className={styles.page} data-scene="behind">
      {failure !== null ? (
        <div className={styles.failure}>
          <h2>The chain did not answer</h2>
          <p>Nothing is shown rather than something invented. The endpoint returned: {failure}</p>
        </div>
      ) : null}

      {loaded === null ? null : (
        <IntentsProvider>
          <TradeLayout
            widget={
              <TradeWidget bases={loaded.bases} quote={loaded.quote} context={loaded.context} />
            }
            intents={
              <MyIntents
                reachable={loaded.context.coordinatorReachable}
                tokens={[...loaded.bases, loaded.quote]}
              />
            }
          />
        </IntentsProvider>
      )}
    </div>
  );
}
