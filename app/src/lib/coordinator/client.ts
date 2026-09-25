import type {
  ApiError,
  ApiErrorCode,
  AuctionResponse,
  BaselineQuote,
  BatchListResponse,
  BatchReceipt,
  CoordinatorHealth,
  CurrentBatchResponse,
  HealthResponse,
  Hex,
  IntentStatusResponse,
  NonceResponse,
  Outcome,
  SubmitIntentResponse,
} from "./types";

const BASE = process.env.NEXT_PUBLIC_COORDINATOR_URL ?? null;

/*
 * What a reader sees, and what a developer needs, are different sentences. The
 * variable name belongs in a console rather than on a product surface.
 */
const NOT_CONFIGURED = "This build has no coordinator to talk to";

if (BASE === null && typeof window !== "undefined") {
  console.warn("Set NEXT_PUBLIC_COORDINATOR_URL to point the app at a running coordinator");
}

function localError(code: ApiErrorCode, message: string): ApiError {
  return {code, message};
}

/* Failures arrive as ApiError, 503s included. The reason survives to the screen. */
async function call<T>(path: string, init?: RequestInit): Promise<Outcome<T>> {
  if (BASE === null) {
    return {ok: false, error: localError("COORDINATOR_NOT_IMPLEMENTED", NOT_CONFIGURED)};
  }

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      // Only a request with a body needs the content type, and setting it on a
      // GET makes the browser send a preflight before every read.
      headers:
        init?.body === undefined
          ? init?.headers
          : {"content-type": "application/json", ...(init.headers ?? {})},
    });
  } catch (error) {
    return {
      ok: false,
      error: localError(
        "COORDINATOR_UPSTREAM_DOWN",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      error: localError("COORDINATOR_UPSTREAM_DOWN", `answered ${response.status} with no json`),
    };
  }

  if (!response.ok) {
    const error = body as Partial<ApiError>;
    return {
      ok: false,
      error: {
        code: error.code ?? "COORDINATOR_UPSTREAM_DOWN",
        message: error.message ?? `answered ${response.status}`,
        ...(error.detail === undefined ? {} : {detail: error.detail}),
      },
    };
  }

  return {ok: true, value: body as T};
}

export function coordinatorUrl(): string | null {
  return BASE;
}

export async function health(): Promise<CoordinatorHealth> {
  if (BASE === null) {
    return {reachable: false, url: null, detail: NOT_CONFIGURED, components: null};
  }
  const result = await call<HealthResponse>("/v1/health");
  if (!result.ok) {
    return {reachable: false, url: BASE, detail: result.error.message, components: null};
  }
  return {
    reachable: result.value.ok,
    url: BASE,
    detail: result.value.ok ? "Reachable" : "The coordinator reports itself unhealthy",
    components: result.value.components,
  };
}

/// Null during a guard band or an auction phase, both of which are normal.
export async function currentBatch(): Promise<Outcome<CurrentBatchResponse>> {
  return call<CurrentBatchResponse>("/v1/batches/current");
}

/* Permit2 nonces live in a bitmap, so nothing can be signed before this answers. */
export async function nextNonce(owner: string): Promise<Outcome<NonceResponse>> {
  return call<NonceResponse>(`/v1/nonces/${owner}`);
}

export async function submitIntent(payload: {
  intent: Record<string, string | number>;
  signature: Hex;
}): Promise<Outcome<SubmitIntentResponse>> {
  return call<SubmitIntentResponse>("/v1/intents", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function intentStatus(intentHash: string): Promise<Outcome<IntentStatusResponse>> {
  return call<IntentStatusResponse>(`/v1/intents/${intentHash}`);
}

/* The failure variant comes back in this same shape, docs/demo.md section 3. */
export async function batchReceipt(batchId: string): Promise<Outcome<BatchReceipt>> {
  return call<BatchReceipt>(`/v1/batches/${batchId}`);
}

export async function auction(auctionId: string): Promise<Outcome<AuctionResponse>> {
  return call<AuctionResponse>(`/v1/auctions/${auctionId}`);
}

/* Keyset paged, newest first. The cursor is the last batchId of the page. */
export async function listBatches(cursor?: string): Promise<Outcome<BatchListResponse>> {
  const query = cursor === undefined ? "" : `?cursor=${cursor}`;
  return call<BatchListResponse>(`/v1/batches${query}`);
}

/*
 * What the venue would pay for this size at this block. Indicative only. The
 * price a batch clears at is not known until it closes, and the unavailable
 * field carries the venue's own reason when the adapter cannot answer at all.
 */
export async function quote(args: {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
}): Promise<Outcome<BaselineQuote>> {
  const query = new URLSearchParams(args).toString();
  return call<BaselineQuote>(`/v1/quote?${query}`);
}
