import {Countdown} from "./Countdown";
import {
  BandIcon,
  BellIcon,
  BlockIcon,
  ClockIcon,
  GlobeIcon,
  LayersIcon,
  MoonIcon,
  ShieldIcon,
  SunIcon,
} from "@/components/Icons";
import {AddressChip} from "@/components/ui/AddressChip";
import {Hint} from "@/components/ui/Hint";
import {OwlState} from "@/components/ui/OwlState";
import {explorerAddress} from "@/lib/chain";
import {readSession, SESSION_NAMES, type SessionReport, type TokenOracle} from "@/lib/session";
import {active, type Network} from "@/lib/network";
import {units} from "@/lib/format";
import {Session} from "@shared/types";
import styles from "./page.module.css";

export const metadata = {title: "Session"};

export const dynamic = "force-dynamic";

/*
 * The session is the first thing this screen is for, so it gets a picture. Four
 * pictures cover nine sessions, because what a person needs to tell apart is
 * whether the market is trading, crossing, shut or held.
 */
const FACE: Record<Session, {Icon: typeof MoonIcon; tone: string}> = {
  [Session.OPEN]: {Icon: SunIcon, tone: "open"},
  [Session.PRE_MARKET]: {Icon: SunIcon, tone: "open"},
  [Session.POST_MARKET]: {Icon: SunIcon, tone: "open"},
  [Session.AUCTION_OPEN]: {Icon: BellIcon, tone: "auction"},
  [Session.AUCTION_CLOSE]: {Icon: BellIcon, tone: "auction"},
  [Session.CLOSED_OVERNIGHT]: {Icon: MoonIcon, tone: "closed"},
  [Session.CLOSED_WEEKEND]: {Icon: MoonIcon, tone: "closed"},
  [Session.HOLIDAY]: {Icon: MoonIcon, tone: "closed"},
  [Session.PROTECTIVE]: {Icon: ShieldIcon, tone: "protective"},
};

function utc(seconds: bigint | number): string {
  return new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function OracleRow({token, chainId}: {token: TokenOracle; chainId: number}) {
  const priceOf = (value: bigint | null, error: string | null) =>
    value === null ? (
      <span className={`${styles.badge} ${styles.warn} chainvalue`}>{error ?? "unreadable"}</span>
    ) : (
      <span className="chainvalue">{units(value, 18, 4)}</span>
    );

  return (
    <tr>
      <td>
        <div className={styles.tokenCell}>
          <span className={styles.tokenMark} aria-hidden="true">
            {token.symbol.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <div className={styles.symbol}>{token.symbol}</div>
            <AddressChip
              value={token.address}
              href={explorerAddress(token.address, chainId)}
              label={`the ${token.symbol} address`}
            />
          </div>
        </div>
      </td>
      <td>{priceOf(token.refPrice, token.refError)}</td>
      <td>{priceOf(token.chainlink, token.dualError)}</td>
      <td>{priceOf(token.uniTwap, token.dualError)}</td>
      <td>
        {token.agree === null ? (
          <span className={styles.muted}>not answered</span>
        ) : (
          <span className={`${styles.badge} ${token.agree ? styles.ok : styles.bad}`}>
            {token.agree ? "Agree" : "Disagree"}
          </span>
        )}
      </td>
      <td>
        {token.tokenSession === null ? (
          <span className={styles.muted}>not answered</span>
        ) : (
          <span
            className={`${styles.badge} ${token.tokenSession === Session.PROTECTIVE ? styles.bad : styles.ok}`}
          >
            {SESSION_NAMES[token.tokenSession]}
          </span>
        )}
      </td>
    </tr>
  );
}

function Report({report, network}: {report: SessionReport; network: Network}) {
  const batch = report.batchDuration;
  const face = FACE[report.session];

  return (
    <>
      <div className={styles.hero}>
        <span className={`${styles.face} ${styles[face.tone]}`} aria-hidden="true">
          <face.Icon size={30} />
        </span>
        <div>
          <p className={styles.eyebrow}>Session right now</p>
          <h1 className={styles.session}>{SESSION_NAMES[report.session]}</h1>
          <p className={styles.until}>
            <ClockIcon size={14} />
            Changes in{" "}
            <Countdown target={Number(report.nextTransition)} readAt={Number(report.blockTimestamp)} />
            <Hint label="When exactly">
              At <span className="chainvalue">{utc(report.nextTransition)} UTC</span>, read from
              SessionManager. This page never works the calendar out for itself.
            </Hint>
          </p>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.card}>
          <p className={styles.label}>
            <LayersIcon size={15} />
            Batch window
            <Hint label="What the batch window is">
              {batch === 0
                ? "This session settles by auction, not by batch."
                : "Intents collect for this long, then the batch clears at one price."}
            </Hint>
          </p>
          <p className={`${styles.value} chainvalue`}>{batch === 0 ? "none" : `${batch}s`}</p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>
            <BandIcon size={15} />
            Price band
            <Hint label="What the price band is">
              The furthest an execution may sit from the reference price in this session.
            </Hint>
          </p>
          <p className={`${styles.value} chainvalue`}>{report.maxDeviationBps} bps</p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>
            <ShieldIcon size={15} />
            Guard band
            <Hint label="What the guard band is">
              The minutes around a session edge, where a batch could straddle two states. Nothing
              opens inside it.
            </Hint>
          </p>
          <p className={styles.value}>{report.inGuardBand ? "Inside" : "Outside"}</p>
        </div>
        <div className={styles.card}>
          <p className={styles.label}>
            <SunIcon size={15} />
            New York day
            <Hint label="Why the New York day">
              Daily budgets reset on the New York calendar day, not on UTC midnight.
            </Hint>
          </p>
          <p className={`${styles.value} chainvalue`}>{report.easternDay}</p>
        </div>
      </div>

      <p className={styles.sectionLabel}>Price sources, per token</p>
      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Token</th>
              <th>Reference</th>
              <th>Chainlink</th>
              <th>Uniswap V3 TWAP</th>
              <th>Agreement</th>
              <th>Token session</th>
            </tr>
          </thead>
          <tbody>
            {report.tokens.map((token) => (
              <OracleRow key={token.address} token={token} chainId={report.chainId} />
            ))}
          </tbody>
        </table>
      </div>

      {network.kind === "testnet" ? (
        <p className={styles.note}>
          A reading that says FeedNotSet is the contract answering, not the page failing. Chain{" "}
          {report.chainId} carries no Chainlink equity feeds, so PriceOracle has none registered
          for these test tokens and says so. The same screen against a chain with feeds shows
          prices.
        </p>
      ) : null}

      <div className={styles.provenance}>
        <span>
          <BlockIcon size={15} />
          Block
          <strong className="chainvalue">{report.blockNumber.toLocaleString("en-US")}</strong>
        </span>
        <span>
          <GlobeIcon size={15} />
          {network.name}
          <strong className="chainvalue">{report.chainId}</strong>
          {network.note === null ? null : <Hint label="Where this chain comes from">{network.note}</Hint>}
        </span>
        <span>
          <ClockIcon size={15} />
          Block time
          <strong className="chainvalue">{utc(report.blockTimestamp)} UTC</strong>
        </span>
        <span>
          SessionManager
          <AddressChip
            value={report.sessionManager}
            href={explorerAddress(report.sessionManager, report.chainId)}
            label="the SessionManager address"
          />
        </span>
        <span>
          PriceOracle
          <AddressChip
            value={report.oracle}
            href={explorerAddress(report.oracle, report.chainId)}
            label="the PriceOracle address"
          />
        </span>
      </div>
    </>
  );
}

export default async function SessionPage() {
  let report: SessionReport | null = null;
  let network: Network | null = null;
  let failure: string | null = null;

  try {
    const now = await active();
    network = now.network;
    report = await readSession(now.network.chainId, now.bases, now.contracts);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className={styles.page}>
      {failure !== null ? (
        <OwlState mood="asleep" title="The chain did not answer" detail={failure}>
          Nothing is shown rather than something invented.
        </OwlState>
      ) : null}
      {report === null || network === null ? null : <Report report={report} network={network} />}
    </div>
  );
}
