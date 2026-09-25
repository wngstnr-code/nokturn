/// The slice of packages/shared/api-types.ts the screens read. That file is the
/// frozen contract and it belongs to the backend, docs/pembagian-tugas.md.

export type {
  Address,
  ApiError,
  ApiErrorCode,
  AuctionResponse,
  BaselineQuote,
  BatchListResponse,
  BatchOutcome,
  BatchReceipt,
  BatchSummary,
  ClearingPriceRow,
  CurrentBatchResponse,
  FillReceipt,
  HealthResponse,
  Hex,
  IntentPayload,
  IntentStatus,
  IntentStatusResponse,
  NonceResponse,
  Provenance,
  SolutionSummary,
  SubmitIntentResponse,
  TokenRef,
  Uint,
  VenueRoute,
  VerifiableCall,
} from "@shared/api-types";

import type {ApiError, HealthResponse} from "@shared/api-types";

/// Answering at all is a different question from reporting itself healthy.
export type CoordinatorHealth = {
  reachable: boolean;
  url: string | null;
  detail: string;
  components: HealthResponse["components"] | null;
};

/// Carries the reason to the screen instead of a status number.
export type Outcome<T> = {ok: true; value: T} | {ok: false; error: ApiError};
