// Shared by the API and the indexer, so both read an RPC list, hide a key and
// tell a missing method from a failed request the same way.

/** A comma separated list, first one primary, the rest fallbacks in order. */
export function parseRpcList(value: string): string[] {
  const urls = value.split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error("no RPC url given");
  return urls;
}

/** A paid endpoint carries its key in the path, so only scheme and host are shown. */
export function redactUrl(url: string): string {
  return url.replace(/^(https?:\/\/[^/\s]+)\/\S+$/, "$1/<redacted>");
}

/** True when the url has a path past the host, which is where a provider puts its key. */
export function carriesPath(url: string): boolean {
  return /^https?:\/\/[^/\s]+\/\S/.test(url);
}

/**
 * Whether an error means the node does not know the method, as opposed to the
 * request failing. Measured 28 September 2026: Alchemy answers -32600
 * "Unsupported method", drpc answers HTTP 400 with no body, and the standard
 * code is -32601. A 5xx, a 429, a timeout or an internal error is not an answer.
 */
export function unknownMethod(error: unknown): boolean {
  for (let e = error as {code?: number; status?: number; message?: string; cause?: unknown} | undefined; e; e = e.cause as typeof e) {
    if (e.code === -32601) return true;
    if (e.status === 400 || e.status === 404 || e.status === 405) return true;
    if (/unsupported method|unknown method|method .*(not found|does not exist|not supported|is not available)/i.test(e.message ?? "")) return true;
  }
  return false;
}
