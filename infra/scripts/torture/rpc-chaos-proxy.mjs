// A JSON-RPC proxy that misbehaves on purpose, placed between the API and anvil.
//
// Only the torture harness ever starts it. The API is pointed here through
// NOKTURN_API_RPC and has no idea it is not talking to the node.
//
// Rules decide what happens to a request. Each rule matches on method, and
// optionally on the four byte selector of an eth_call, and applies one mode.
//   pass      forward untouched
//   latency   forward after ms, plus a random jitter up to jitterMs
//   drop      destroy the socket without answering, for pct percent of matches
//   error     answer with a JSON-RPC error, for pct percent of matches
//   hang      never answer
// A rule with count set applies that many times and then retires.
//
// Standalone it takes rules as JSON on a control port.
//   node rpc-chaos-proxy.mjs --upstream http://127.0.0.1:8545 --port 8600 --control 8601
//   curl -X POST 127.0.0.1:8601/rules -d '[{"mode":"hang","methods":["eth_getCode"]}]'

import {createServer} from "node:http";
import {fileURLToPath} from "node:url";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function selectorOf(call) {
  if (call?.method !== "eth_call") return null;
  const data = call.params?.[0]?.data ?? call.params?.[0]?.input;
  return typeof data === "string" ? data.slice(0, 10).toLowerCase() : null;
}

function matches(rule, call) {
  if (rule.methods && !rule.methods.includes(call.method)) return false;
  if (rule.selectors && !rule.selectors.includes(selectorOf(call))) return false;
  return true;
}

export async function startChaosProxy({upstream, port = 0, host = "127.0.0.1"}) {
  let rules = [];
  const stats = {requests: 0, byMethod: {}, bySelector: {}, dropped: 0, errored: 0, hung: 0};
  const hanging = new Set();

  const decide = (calls) => {
    for (const rule of rules) {
      if (rule.count !== undefined && rule.count <= 0) continue;
      if (!calls.some((c) => matches(rule, c))) continue;
      if (rule.pct !== undefined && Math.random() * 100 >= rule.pct) continue;
      if (rule.count !== undefined) rule.count -= 1;
      return rule;
    }
    return null;
  };

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const calls = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    stats.requests += 1;
    for (const call of calls) {
      stats.byMethod[call.method] = (stats.byMethod[call.method] ?? 0) + 1;
      const sel = selectorOf(call);
      if (sel) stats.bySelector[sel] = (stats.bySelector[sel] ?? 0) + 1;
    }

    const rule = decide(calls);
    const mode = rule?.mode ?? "pass";

    if (mode === "hang") {
      stats.hung += 1;
      hanging.add(res);
      res.on("close", () => hanging.delete(res));
      return;
    }
    if (mode === "drop") {
      stats.dropped += 1;
      req.socket.destroy();
      return;
    }
    if (mode === "error") {
      stats.errored += 1;
      const errorFor = (c) => ({jsonrpc: "2.0", id: c.id ?? null, error: {code: -32603, message: "chaos proxy injected error"}});
      const out = Array.isArray(parsed) ? calls.map(errorFor) : errorFor(calls[0] ?? {});
      res.writeHead(200, {"content-type": "application/json"});
      res.end(JSON.stringify(out));
      return;
    }
    if (mode === "latency") {
      const wait = (rule.ms ?? 0) + Math.random() * (rule.jitterMs ?? 0);
      await new Promise((r) => setTimeout(r, wait));
    }

    try {
      const up = await fetch(upstream, {method: "POST", headers: {"content-type": "application/json"}, body: raw});
      const text = await up.text();
      if (res.destroyed) return;
      res.writeHead(up.status, {"content-type": "application/json"});
      res.end(text);
    } catch {
      if (!res.destroyed) req.socket.destroy();
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();

  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    stats,
    setRules(next) {
      rules = next.map((r) => ({...r}));
    },
    pass() {
      rules = [];
    },
    resetStats() {
      stats.requests = 0;
      stats.byMethod = {};
      stats.bySelector = {};
      stats.dropped = 0;
      stats.errored = 0;
      stats.hung = 0;
    },
    /** Answers nothing to the hung requests, it cuts them, the way a dead node would. */
    releaseHung() {
      for (const res of hanging) res.socket?.destroy();
      hanging.clear();
    },
    close() {
      for (const res of hanging) res.socket?.destroy();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const proxy = await startChaosProxy({
    upstream: arg("upstream", process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545"),
    port: Number(arg("port", 8600)),
  });
  const control = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/rules") {
      proxy.setRules(JSON.parse((await readBody(req)) || "[]"));
    } else if (req.method === "POST" && req.url === "/release") {
      proxy.releaseHung();
    }
    res.writeHead(200, {"content-type": "application/json"});
    res.end(JSON.stringify(proxy.stats));
  });
  const controlPort = Number(arg("control", 8601));
  control.listen(controlPort, "127.0.0.1");
  console.log(`chaos proxy ${proxy.url}, control http://127.0.0.1:${controlPort}`);
}
