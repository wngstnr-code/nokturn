import type {
  ApiError,
  ApiErrorCode,
  AuctionResponse,
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

const NOT_CONFIGURED =
  "No coordinator endpoint is configured. Set NEXT_PUBLIC_COORDINATOR_URL once the backend publishes one.";

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
      headers: {"content-type": "application/json", ...(init?.headers ?? {})},
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
