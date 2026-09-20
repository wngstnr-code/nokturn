// Coordinator API schema. Owned by Dharu, frozen 20 September 2026 as
// synchronisation point 3 in docs/pembagian-tugas.md.
//
// Frozen means the shape does not change without telling the other two at
// standup. It does not mean every endpoint is implemented. The frontend codes
// against this file from day one, and a missing implementation shows up as a 503
// with a documented body rather than as a shape nobody planned for.
//
// Three rules the whole schema obeys.
//
// 1. Any integer that can exceed 2^53 is a decimal string, never a JSON number.
//    Token amounts, USD values, batch ids and nonces are all strings. A number
//    here would round silently and the receipt would show a wrong figure that
//    nobody could trace.
// 2. Every token amount travels with the decimals it is denominated in. USDG is
//    six and every stock token is eighteen, and that difference has already cost
//    this protocol one class of bug. See docs/parameter.md section 4C.
// 3. Anything a judge can see carries Provenance. If a number cannot say which
//    block it came from and how to recompute it, it does not belong in a
//    response. See docs/rencana-uji.md section 11.

import type {Intent, Session} from "./types";

export const API_VERSION = "v1";

export type Hex = `0x${string}`;
export type Address = Hex;

/** Decimal string. Parse with BigInt, never with Number. */
export type Uint = string;

/** USD scaled by 1e18, as a decimal string. */
export type UsdWad = Uint;

/** Unix seconds. Safe as a number until the year 285428751. */
export type Timestamp = number;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a number came from, and how somebody who does not trust us can get it
 * again. Attached to every settled figure the UI renders.
 */
export interface Provenance {
  chainId: number;
  /** This chain's block number, from ArbSys. Never the parent chain's. */
  blockNumber: Uint;
  blockTimestamp: Timestamp;
  transactionHash?: Hex;
  logIndex?: number;
  /** "mainnet", "testnet", or "fork" with the block it was pinned at. */
  source: ProvenanceSource;
}

export type ProvenanceSource =
  | {kind: "mainnet"}
  | {kind: "testnet"; note: "tokens on this chain are test tokens"}
  | {kind: "fork"; forkedFrom: number; pinnedBlock: Uint; pinnedAt: Timestamp};

/**
 * A call a judge can paste into cast or into an explorer to get the same number
 * back. This is what the copy button on the receipt copies.
 */
export interface VerifiableCall {
  to: Address;
  data: Hex;
  blockNumber: Uint;
  /** Ready to paste, including the rpc url and the block. */
  castCommand: string;
  /** What the call returns when it is run, so a mismatch is visible. */
  expected: Uint;
  /** Human readable, for example "UniswapV3Adapter.quoteFromState". */
  describes: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * One error shape everywhere. `code` is the contract's own custom error name
 * when the rejection mirrors a contract check, so that a rejection at the API
 * and the same rejection onchain read identically. Anything the contract does
 * not have a name for gets a COORDINATOR_ prefix.
 */
export interface ApiError {
  code: ApiErrorCode;
  message: string;
  /** Decoded revert arguments when the code came from a contract. */
  detail?: Record<string, string | number | boolean>;
  /** Present when the rejection was produced by simulating against the chain. */
  provenance?: Provenance;
}

export type ApiErrorCode =
  // mirrors Settlement and ClearingVerifier, docs/interfaces.md section 3
  | "IntentExpired"
  | "NonceAlreadyUsed"
  | "SessionNotAllowed"
  | "TokenNotAllowed"
  | "LimitViolated"
  | "NonUniformPrice"
  | "ValueNotConserved"
  | "PriceOutsideBand"
  | "SavingsMismatch"
  | "WorseThanBaseline"
  | "BaselineBelowVenue"
  | "ExposureCapExceeded"
  | "BatchNotOpen"
  | "BatchMisaligned"
  | "BatchInGuardBand"
  | "SolutionWindowClosed"
  | "OracleUnhealthy"
  | "ProtocolPaused"
  // the coordinator's own
  | "COORDINATOR_BAD_SIGNATURE"
  | "COORDINATOR_UNKNOWN_OWNER"
  | "COORDINATOR_INSUFFICIENT_BALANCE"
  | "COORDINATOR_PERMIT2_NOT_APPROVED"
  | "COORDINATOR_NO_OPEN_BATCH"
  | "COORDINATOR_DUPLICATE_INTENT"
  | "COORDINATOR_RATE_LIMITED"
  | "COORDINATOR_NOT_IMPLEMENTED"
  | "COORDINATOR_UPSTREAM_DOWN";

// ---------------------------------------------------------------------------
// GET /v1/config
// ---------------------------------------------------------------------------

/**
 * Everything the frontend would otherwise hardcode. Read once at boot.
 *
 * The typehash, the witness type string and the Permit2 domain separator are
 * read out of the deployed contracts rather than copied, because a fork runs a
 * different Settlement address and Permit2 rebuilds its domain separator when
 * the chain id is not the one it was deployed on. A hardcoded copy is correct on
 * exactly one chain and silently wrong on the others.
 */
export interface ConfigResponse {
  apiVersion: typeof API_VERSION;
  chainId: number;
  source: ProvenanceSource;
  contracts: {
    settlement: Address;
    sessions: Address;
    oracle: Address;
    solvers: Address;
    auctionHouse: Address;
    mandates: Address;
    adapter: Address;
    verifier: Address;
    permit2: Address;
    timelock: Address;
  };
  quoteToken: TokenInfo;
  tokens: TokenInfo[];
  eip712: {
    /** Settlement.WITNESS_TYPE_STRING, read from the chain. */
    witnessTypeString: string;
    /** IntentLib.INTENT_TYPEHASH, read from the chain. */
    intentTypehash: Hex;
    /** Permit2.DOMAIN_SEPARATOR(), read from the chain. */
    permit2DomainSeparator: Hex;
    /** The spender Permit2 binds the signature to. Always Settlement. */
    spender: Address;
  };
  limits: {
    capPerBatchUsd: UsdWad;
    capPerTokenDailyUsd: UsdWad;
    capGlobalDailyUsd: UsdWad;
    /** Settlement.SOLUTION_WINDOW, seconds. */
    solutionWindow: number;
    /** Settlement.FINALIZE_DEADLINE, seconds. */
    finalizeDeadline: number;
  };
}

export interface TokenInfo {
  symbol: string;
  address: Address;
  decimals: number;
  /** The Uniswap V3 pool this token quotes against the quote token. */
  pool?: Address;
  /** Chainlink proxy, absent for the quote token. */
  feed?: Address;
  allowed: boolean;
}

// ---------------------------------------------------------------------------
// GET /v1/session
// ---------------------------------------------------------------------------

/**
 * Read straight from SessionManager. The UI never recomputes the calendar. Two
 * implementations of the calendar give two answers in front of a judge, and
 * docs/pembagian-tugas.md section 4 makes that a binding rule.
 */
export interface SessionResponse {
  session: Session;
  sessionName: SessionName;
  chainTime: Timestamp;
  batchDurationSeconds: number;
  maxDeviationBps: number;
  inGuardBand: boolean;
  nextTransition: Timestamp;
  /** Which oracle leads right now. Weekend flips the two around. */
  priceSource: {
    primary: "chainlink" | "uniswapV3Twap";
    anchor: "chainlink" | "uniswapV3Twap" | null;
    disagreementCheckEnabled: boolean;
    weekendDriftCapBps: number | null;
  };
  /** Non empty when a token is in PROTECTIVE, which is per token not per chain. */
  protectiveTokens: {token: Address; symbol: string; reason: string}[];
  provenance: Provenance;
}

export type SessionName =
  | "CLOSED_OVERNIGHT"
  | "PRE_MARKET"
  | "AUCTION_OPEN"
  | "OPEN"
  | "AUCTION_CLOSE"
  | "POST_MARKET"
  | "CLOSED_WEEKEND"
  | "HOLIDAY"
  | "PROTECTIVE";

// ---------------------------------------------------------------------------
// GET /v1/allowlist
// ---------------------------------------------------------------------------

/**
 * The allowlist gate screen, docs/demo.md priority 1. Both checks are reported
 * with the raw value read, so the screen can show why a token passed rather
 * than only that it did.
 */
export interface AllowlistResponse {
  entries: AllowlistEntry[];
  provenance: Provenance;
}

export interface AllowlistEntry {
  symbol: string;
  address: Address;
  verdict: "pass" | "reject";
  checks: {
    /** ERC-1967 beacon slot must hold the shared Stock Token beacon. */
    beaconSlot: {expected: Hex; actual: Hex; pass: boolean};
    /** uiMultiplier() must exist and be at least 1e18. */
    uiMultiplier: {value: Uint | null; pass: boolean};
    codeSize: {value: number; pass: boolean};
  };
  /** Why it was rejected, in words, for the reject column of the screen. */
  reason?: string;
  explorerUrl: string;
}

// ---------------------------------------------------------------------------
// POST /v1/intents
// ---------------------------------------------------------------------------

/**
 * Amounts arrive as decimal strings in the token's own smallest unit. The
 * coordinator does no unit conversion, because a conversion at this boundary is
 * a conversion the signature did not cover.
 */
export interface SubmitIntentRequest {
  intent: IntentPayload;
  /**
   * The Permit2 PermitWitnessTransferFrom signature, with the intent as the
   * witness. Not a signature over the Intent struct on its own. See
   * docs/rencana-backend.md section 2.1.
   */
  signature: Hex;
  /** Set when the owner is a MandateAccount and the check is EIP-1271. */
  signatureKind?: "eoa" | "erc1271";
}

/** Intent with every uint256 as a string, ready for JSON. */
export type IntentPayload = {
  [K in keyof Intent]: Intent[K] extends bigint ? Uint : Intent[K];
};

export interface SubmitIntentResponse {
  intentHash: Hex;
  /** The batch this intent was placed in. */
  batchId: Uint;
  collectEndsAt: Timestamp;
  solveEndsAt: Timestamp;
  status: IntentStatus;
  /**
   * The digest the coordinator reconstructed and verified the signature
   * against. Published so a client that computed a different one can see where
   * the two diverged instead of guessing.
   */
  verifiedDigest: Hex;
  /** An indicative baseline for this size right now. Not a promise. */
  indicativeBaseline: BaselineQuote | null;
}

export type IntentStatus =
  | "pending"
  | "batched"
  | "settled"
  | "partially_settled"
  | "expired"
  | "rejected"
  | "cancelled";

export interface IntentStatusResponse {
  intentHash: Hex;
  status: IntentStatus;
  intent: IntentPayload;
  batchId: Uint | null;
  fill: FillReceipt | null;
  rejection: ApiError | null;
  /**
   * Payload for Settlement.submitIntentOnchain. Always present, so a user whose
   * intent this coordinator refuses to relay can publish it themselves. The
   * single mempool is an acknowledged point of centralisation and this is the
   * way out of it, so it is not optional. See docs/spek-teknis.md section 9.3.
   */
  escapeHatch: {to: Address; data: Hex; castCommand: string};
}

// ---------------------------------------------------------------------------
// GET /v1/quote
// ---------------------------------------------------------------------------

/** GET /v1/quote?sellToken=&buyToken=&sellAmount= */
export interface BaselineQuote {
  sellToken: Address;
  buyToken: Address;
  sellAmount: Uint;
  sellDecimals: number;
  /** What the venue would pay for this size, right now, at this block. */
  baselineBuy: Uint;
  buyDecimals: number;
  pool: Address;
  /** From quoteWithStats. Useful for seeing how close a size is to the cap. */
  tickCrossings: number;
  loopSteps: number;
  /**
   * Null when the adapter reverted. That is a real answer rather than an error,
   * and it is the one that forces a batch to pass through with zero fee. The
   * reason carries the contract error name.
   */
  unavailable: {code: ApiErrorCode; reason: string} | null;
  verify: VerifiableCall;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// GET /v1/batches/current, GET /v1/batches, GET /v1/batches/:batchId
// ---------------------------------------------------------------------------

export interface CurrentBatchResponse {
  /** Null during a guard band or an auction phase, both of which are normal. */
  batchId: Uint | null;
  reason?: "guard_band" | "auction_phase" | "paused";
  session: Session;
  sessionName: SessionName;
  collectStartsAt: Timestamp;
  collectEndsAt: Timestamp;
  solveEndsAt: Timestamp;
  chainTime: Timestamp;
  intentCount: number;
  /** Distinct owners so far, which is what makes netting possible at all. */
  participantCount: number;
  provenance: Provenance;
}

export type BatchOutcome = "settled" | "passthrough" | "expired" | "collecting" | "solving";

/**
 * The receipt. This is the product, docs/demo.md section 2, and the failure
 * variant in section 3 is the same shape rather than a different endpoint.
 * A screen that renders one renders the other.
 */
export interface BatchReceipt {
  batchId: Uint;
  outcome: BatchOutcome;
  session: Session;
  sessionName: SessionName;
  batchDurationSeconds: number;

  intentCount: number;
  participantCount: number;

  /** Present once a winner is picked. */
  solver: Address | null;
  /** Every solution seen, winners and losers. Losers are the interesting half. */
  solutions: SolutionSummary[];

  fills: FillReceipt[];
  clearingPrices: ClearingPriceRow[];
  venueRoutes: VenueRoute[];

  totals: {
    notionalUsd: UsdWad;
    nettedVolumeUsd: UsdWad;
    routedVolumeUsd: UsdWad;
    /** nettedVolumeUsd / (netted + routed), as a string in basis points. */
    nettingRatioBps: string;
    totalSavingsUsd: UsdWad;
    solverFeeUsd: UsdWad;
    protocolFeeUsd: UsdWad;
  };

  /**
   * Set when the batch did not settle. Carries the baseline anyway, which is
   * the whole point of the failure screen. A protocol that publishes nothing on
   * failure is asking to be trusted that the failure was honest.
   */
  failure: {
    code: ApiErrorCode;
    reason: string;
    bestSolutionBuy: Uint | null;
    baselineBuy: Uint | null;
    shortfall: Uint | null;
    feeCharged: "0";
  } | null;

  provenance: Provenance;
}

export interface SolutionSummary {
  solver: Address;
  solutionHash: Hex;
  claimedSavingsUsd: UsdWad;
  accepted: boolean;
  /** "not the best", "savings mismatch", or a contract error name. */
  rejectionReason: string | null;
  submittedAt: Timestamp;
  provenance: Provenance;
}

export interface FillReceipt {
  intentHash: Hex;
  owner: Address;
  receiver: Address;
  sellToken: TokenRef;
  buyToken: TokenRef;
  executedSell: Uint;
  executedBuy: Uint;
  /** What this user would have received alone, at this size, at this block. */
  baselineBuy: Uint;
  savingsUsd: UsdWad;
  /** executedBuy - baselineBuy over baselineBuy, in basis points. */
  improvementBps: string;
  /** How much of this fill met another intent instead of reaching a venue. */
  attribution: {
    nettedSell: Uint;
    routedSell: Uint;
  };
  partial: boolean;
  /** The copy button on the receipt. */
  verifyBaseline: VerifiableCall;
  provenance: Provenance;
}

export interface TokenRef {
  address: Address;
  symbol: string;
  decimals: number;
  explorerUrl: string;
}

export interface ClearingPriceRow {
  token: TokenRef;
  /** USD 18 decimals per smallest unit, scaled by 1e18. parameter.md 4C. */
  price: Uint;
  refPrice: Uint;
  deviationBps: string;
  withinBand: boolean;
}

export interface VenueRoute {
  adapter: Address;
  pool: Address;
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  amountIn: Uint;
  minOut: Uint;
  amountOut: Uint;
  explorerUrl: string;
}

export interface BatchListResponse {
  batches: BatchSummary[];
  cursor: string | null;
}

export interface BatchSummary {
  batchId: Uint;
  outcome: BatchOutcome;
  sessionName: SessionName;
  intentCount: number;
  participantCount: number;
  nettingRatioBps: string;
  totalSavingsUsd: UsdWad;
  settledAt: Timestamp | null;
}

// ---------------------------------------------------------------------------
// GET /v1/solvers
// ---------------------------------------------------------------------------

export interface SolverBoardResponse {
  solvers: SolverRow[];
  provenance: Provenance;
}

export interface SolverRow {
  address: Address;
  label: string | null;
  bonded: Uint;
  active: boolean;
  batchesWon: number;
  savingsGeneratedUsd: UsdWad;
  failedFinalizes: number;
  slashCount: number;
}

// ---------------------------------------------------------------------------
// GET /v1/auctions/:auctionId
// ---------------------------------------------------------------------------

export interface AuctionResponse {
  auctionId: Uint;
  token: TokenRef;
  kind: "open" | "close";
  phase: "accumulating" | "disclosing" | "frozen" | "crossed" | "aborted";
  crossAt: Timestamp;
  indicativePrice: Uint | null;
  /** Signed. Positive is a buy imbalance, negative is a sell imbalance. */
  imbalance: string | null;
  matchedVolume: Uint | null;
  participantCount: number;
  extensions: number;
  collarBps: number;
  result: {
    price: Uint;
    volume: Uint;
    participants: number;
    sufficient: boolean;
  } | null;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// WS /v1/stream
// ---------------------------------------------------------------------------

/**
 * One envelope so a client can switch on `type` and nothing else. Every event
 * carries the same provenance as the REST body it corresponds to, so a screen
 * driven by the socket is as verifiable as one driven by a fetch.
 */
export type StreamEvent =
  | {type: "batch.opened"; at: Timestamp; data: CurrentBatchResponse}
  | {type: "batch.intent_added"; at: Timestamp; data: {batchId: Uint; intentHash: Hex; intentCount: number; participantCount: number}}
  | {type: "batch.collect_closed"; at: Timestamp; data: {batchId: Uint; intentCount: number; solveEndsAt: Timestamp}}
  | {type: "batch.solution_submitted"; at: Timestamp; data: SolutionSummary & {batchId: Uint}}
  | {type: "batch.solution_rejected"; at: Timestamp; data: SolutionSummary & {batchId: Uint}}
  | {type: "batch.settled"; at: Timestamp; data: BatchReceipt}
  | {type: "batch.failed"; at: Timestamp; data: BatchReceipt}
  | {type: "session.changed"; at: Timestamp; data: SessionResponse}
  | {type: "token.protective"; at: Timestamp; data: {token: Address; symbol: string; reason: string; cleared: boolean}}
  | {type: "oracle.unhealthy"; at: Timestamp; data: {token: Address; symbol: string; reason: "stale" | "disagreement"; detail: string}}
  | {type: "auction.indicative"; at: Timestamp; data: AuctionResponse}
  | {type: "auction.crossed"; at: Timestamp; data: AuctionResponse};

export interface StreamSubscribe {
  type: "subscribe";
  topics: StreamEvent["type"][];
  /** Only deliver events touching this owner. Omit for everything. */
  owner?: Address;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * The frozen surface, listed once so the three of us are reading the same list
 * rather than three copies of it.
 */
export const ROUTES = {
  health: "GET /v1/health",
  config: "GET /v1/config",
  session: "GET /v1/session",
  allowlist: "GET /v1/allowlist",
  quote: "GET /v1/quote",
  submitIntent: "POST /v1/intents",
  intentStatus: "GET /v1/intents/:intentHash",
  currentBatch: "GET /v1/batches/current",
  listBatches: "GET /v1/batches",
  batchReceipt: "GET /v1/batches/:batchId",
  solvers: "GET /v1/solvers",
  auction: "GET /v1/auctions/:auctionId",
  stream: "WS /v1/stream",
} as const;

export interface HealthResponse {
  ok: boolean;
  apiVersion: typeof API_VERSION;
  chainId: number;
  /** How far behind the chain the indexer is, in blocks. */
  indexerLagBlocks: Uint;
  components: Record<"rpc" | "indexer" | "database" | "scheduler", "up" | "degraded" | "down">;
}
