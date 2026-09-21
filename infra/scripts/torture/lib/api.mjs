// Starts and stops a private coordinator for the torture suite.
//
// The mempool lives in process memory, so restarting the process is the only
// honest way to empty it. A reset endpoint would be a debug hook on the product
// surface, which CLAUDE.md rule 9 forbids. This one listens on 3100 so it never
// collides with an API a person is running on 3000.

import {execFileSync, spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {FORK_RPC} from "./fork.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const API_DIR = join(REPO_ROOT, "api");

export const DEFAULT_PORT = Number(process.env.NOKTURN_TORTURE_PORT ?? 3100);

export async function startApi({rpc = FORK_RPC, port = DEFAULT_PORT, env = {}} = {}) {
  const logs = [];
  const proc = spawn(process.execPath, ["src/index.ts"], {
    cwd: API_DIR,
    env: {
      ...process.env,
      NOKTURN_API_RPC: rpc,
      NOKTURN_API_PORT: String(port),
      NOKTURN_API_LOG_LEVEL: process.env.NOKTURN_TORTURE_LOG_LEVEL ?? "error",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      logs.push(line);
      if (logs.length > 2000) logs.shift();
    }
  };
  proc.stdout.on("data", keep);
  proc.stderr.on("data", keep);

  const exited = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({code, signal})));
  const api = {
    proc,
    port,
    url: `http://127.0.0.1:${port}`,
    pid: proc.pid,
    logs,
    exited,
    async stop(signal = "SIGTERM") {
      if (proc.exitCode !== null || proc.signalCode !== null) return exited;
      proc.kill(signal);
      const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
      const result = await exited;
      clearTimeout(timer);
      return result;
    },
  };

  const startedAt = performance.now();
  await waitReady(api, 30_000);
  api.bootMs = Math.round(performance.now() - startedAt);
  return api;
}

export async function waitReady(api, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (api.proc.exitCode !== null) {
      throw new Error(`api exited during boot with ${api.proc.exitCode}.\n${api.logs.slice(-20).join("\n")}`);
    }
    try {
      const res = await fetch(`${api.url}/`, {signal: AbortSignal.timeout(1000)});
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`api on ${api.url} did not answer within ${timeoutMs} ms.\n${api.logs.slice(-20).join("\n")}`);
}

/**
 * One request, timed. Returns the parsed body when it is JSON and the raw text
 * either way, because several scenarios are about what comes back when the
 * body is not the shape it should be.
 */
export async function request(api, path, {method = "GET", headers = {}, body, timeoutMs = 60_000} = {}) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${api.url}${path}`, {method, headers, body, signal: AbortSignal.timeout(timeoutMs)});
  } catch (error) {
    return {status: 0, body: null, text: "", ms: Math.round(performance.now() - started), error: error.name};
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return {status: res.status, body: parsed, text, headers: res.headers, ms: Math.round(performance.now() - started)};
}

export function get(api, path, opts = {}) {
  return request(api, path, opts);
}

export function post(api, path, json, opts = {}) {
  return request(api, path, {
    method: "POST",
    headers: {"content-type": "application/json", ...(opts.headers ?? {})},
    body: typeof json === "string" ? json : JSON.stringify(json),
    timeoutMs: opts.timeoutMs,
  });
}

export function submit(api, signed, opts) {
  return post(api, "/v1/intents", {intent: signed.intent, signature: signed.signature}, opts);
}

/** Resident memory of a process in bytes, read from the OS rather than from inside it. */
export function rssOf(pid) {
  if (process.platform === "linux") {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
    return kb * 1024;
  }
  if (process.platform === "win32") {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {encoding: "utf8"});
    const fields = out.trim().split('","');
    const kb = Number((fields[4] ?? "0").replace(/[^0-9]/g, ""));
    return kb * 1024;
  }
  const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {encoding: "utf8"});
  return Number(out.trim()) * 1024;
}

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}
