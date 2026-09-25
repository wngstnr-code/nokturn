import {IntentsProvider} from "@/components/trade/IntentsProvider";
import {MyIntents} from "@/components/trade/MyIntents";
import {TradeWidget, type TradeContext} from "@/components/trade/TradeWidget";
import {health} from "@/lib/coordinator/client";
import {deploymentFor} from "@/lib/deployments";
import {signingContext} from "@/lib/permit2";
import {readSession, SESSION_NAMES} from "@/lib/session";
import {baseTokens, quoteToken, type TokenInfo} from "@/lib/tokens";
import {CHAIN_ID_TESTNET} from "@shared/addresses";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

const CHAIN = CHAIN_ID_TESTNET;

type Loaded = {bases: TokenInfo[]; quote: TokenInfo; context: TradeContext};

async function load(): Promise<Loaded> {
  const deployment = deploymentFor(CHAIN);
  if (deployment === null) throw new Error(`Nokturn is not deployed on chain ${CHAIN}`);

  const [bases, quote, session, coordinator, signing] = await Promise.all([
    baseTokens(CHAIN),
    quoteToken(CHAIN),
    readSession(CHAIN, []),
    health(),
    signingContext(CHAIN, deployment.settlement, deployment.permit2),
  ]);

  return {
    bases,
    quote,
    context: {
      chainId: CHAIN,
      settlement: deployment.settlement,
      permit2: deployment.permit2,
      signingOk: signing.ok,
      signingProblem: signing.problem,
      sessionName: SESSION_NAMES[session.session],
      batchDuration: session.batchDuration,
      maxDeviationBps: session.maxDeviationBps,
      coordinatorDetail: coordinator.detail,
      coordinatorReachable: coordinator.reachable,
    },
  };
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
    <div className={styles.page}>
      {failure !== null ? (
        <div className={styles.failure}>
          <h2>The chain did not answer</h2>
          <p>Nothing is shown rather than something invented. The endpoint returned: {failure}</p>
        </div>
      ) : null}

      {loaded === null ? null : (
        <IntentsProvider>
          <div className={styles.primary}>
            <TradeWidget bases={loaded.bases} quote={loaded.quote} context={loaded.context} />
          </div>
          <div className={styles.secondary}>
            <MyIntents
              reachable={loaded.context.coordinatorReachable}
              tokens={[...loaded.bases, loaded.quote]}
            />
          </div>
        </IntentsProvider>
      )}
    </div>
  );
}
