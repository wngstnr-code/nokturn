// A WS /v1/stream client for the torture suite, on Node's own WebSocket.

export const BATCH_TOPICS = ["batch.opened", "batch.intent_added", "batch.collect_closed"];
export const LIVE_TOPICS = [...BATCH_TOPICS, "session.changed", "token.protective", "oracle.unhealthy"];

/**
 * Connects and, when topics are given, subscribes. Every frame is kept with the
 * laptop time it arrived, which is what a latency between two clients is
 * measured in. Chain time is what the frames themselves carry.
 */
export async function connect(api, {topics, owner, timeoutMs = 10_000} = {}) {
  const url = `${api.url.replace(/^http/, "ws")}/v1/stream`;
  const ws = new WebSocket(url);
  const client = {ws, frames: [], closed: null, waiters: new Set()};

  const notify = () => {
    for (const w of client.waiters) w();
  };
  ws.addEventListener("message", (e) => {
    client.frames.push({receivedAt: performance.now(), frame: JSON.parse(e.data)});
    notify();
  });
  client.closedPromise = new Promise((resolve) => {
    ws.addEventListener("close", (e) => {
      client.closed = {code: e.code, reason: e.reason};
      notify();
      resolve(client.closed);
    });
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no open on ${url} within ${timeoutMs} ms`)), timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (topics && !client.closed) send(client, {type: "subscribe", topics, ...(owner ? {owner} : {})});
  return client;
}

export function send(client, message) {
  client.ws.send(typeof message === "string" ? message : JSON.stringify(message));
}

export const events = (client, type) => client.frames.filter((f) => f.frame.type === type);
export const errors = (client) => client.frames.filter((f) => f.frame.code !== undefined);

/** Resolves with the first frame entry matching pred, or null on timeout. */
export function waitFor(client, pred, timeoutMs = 30_000) {
  const found = () => client.frames.find(pred) ?? null;
  if (found()) return Promise.resolve(found());
  return new Promise((resolve) => {
    const check = () => {
      const f = found();
      if (f || client.closed) finish(f);
    };
    const finish = (f) => {
      clearTimeout(timer);
      client.waiters.delete(check);
      resolve(f);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    client.waiters.add(check);
  });
}

export function waitClosed(client, timeoutMs = 30_000) {
  if (client.closed) return Promise.resolve(client.closed);
  return Promise.race([client.closedPromise, new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
}

export async function closeAll(clients) {
  for (const c of clients) if (!c.closed) c.ws.close();
  await Promise.all(clients.map((c) => waitClosed(c, 5000)));
}
