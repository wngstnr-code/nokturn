// Group H. The HTTP surface, below any route's own logic.

import assert from "node:assert/strict";
import {connect} from "node:net";
import {describe, test} from "node:test";
import {get, request, rssOf} from "./lib/api.mjs";
import {mb} from "./lib/evidence.mjs";
import {useGroup} from "./lib/harness.mjs";

const g = useGroup(import.meta.url);

const isApiError = (body) => !!body && typeof body.code === "string" && typeof body.message === "string";

describe("H HTTP surface", () => {
  test("H-1 a body over the Fastify limit", async () => {
    const body = JSON.stringify({intent: {pad: "x".repeat(2 * 1024 * 1024)}, signature: "0x11"});
    const res = await request(g.api, "/v1/intents", {method: "POST", headers: {"content-type": "application/json"}, body});
    const ok = res.status === 413 && isApiError(res.body) && res.body.code === "COORDINATOR_INVALID_REQUEST";
    g.record("H-1", {outcome: ok ? "pass" : "finding", suspect: "D13", summary: `body 2 MB dijawab ${res.status} ${res.body?.code}`, evidence: {message: res.body?.message}});
    assert.ok(ok);
  });

  test("H-2 content types that are not JSON", async () => {
    const payload = '{"intent":{},"signature":"0x11"}';
    const cases = {
      textPlain: {"content-type": "text/plain"},
      formUrlEncoded: {"content-type": "application/x-www-form-urlencoded"},
      none: {},
    };
    const results = {};
    for (const [name, headers] of Object.entries(cases)) {
      const res = await request(g.api, "/v1/intents", {method: "POST", headers, body: payload});
      results[name] = {status: res.status, code: res.body?.code, shape: isApiError(res.body)};
    }
    const bad = Object.entries(results).filter(([, r]) => !(r.status >= 400 && r.status < 500 && r.shape));
    g.record("H-2", {
      outcome: bad.length === 0 ? "pass" : "finding",
      suspect: "D13",
      summary: Object.entries(results).map(([k, v]) => `${k} ${v.status} ${v.code}`).join(", "),
    });
    assert.deepEqual(bad.map(([k]) => k), []);
  });

  test("H-3 JSON nested ten thousand levels deep", async () => {
    const before = rssOf(g.api.pid);
    const deep = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
    const res = await request(g.api, "/v1/intents", {method: "POST", headers: {"content-type": "application/json"}, body: `{"intent":${deep},"signature":"0x11"}`});
    const alive = (await get(g.api, "/")).status === 200;
    await new Promise((r) => setTimeout(r, 2000));
    const after = rssOf(g.api.pid);
    const ok = res.status === 400 && alive;
    g.record("H-3", {outcome: ok ? "pass" : "finding", summary: `${res.status} ${res.body?.code}, proses hidup ${alive}, RSS ${mb(before)} MB lalu ${mb(after)} MB`});
    assert.ok(ok);
  });

  test("H-4 two hundred slowloris connections", {timeout: 5 * 60_000}, async () => {
    const sockets = [];
    const closedAt = [];
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) {
      const s = connect(g.api.port, "127.0.0.1");
      s.on("error", () => {});
      s.on("close", () => closedAt.push(Math.round((performance.now() - started) / 1000)));
      s.write("POST /v1/intents HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n");
      sockets.push(s);
    }
    const drip = setInterval(() => {
      for (const s of sockets) if (!s.destroyed) s.write("x");
    }, 1000);
    const latencies = [];
    const observeSeconds = Number(process.env.NOKTURN_TORTURE_SLOWLORIS_SECONDS ?? 90);
    const until = performance.now() + observeSeconds * 1000;
    while (performance.now() < until) {
      const res = await get(g.api, "/v1/session", {timeoutMs: 10_000});
      latencies.push(res.status === 200 ? res.ms : -1);
      await new Promise((r) => setTimeout(r, 1000));
    }
    clearInterval(drip);
    const stillOpen = sockets.filter((s) => !s.destroyed).length;
    for (const s of sockets) s.destroy();
    const failed = latencies.filter((l) => l < 0).length;
    const worst = Math.max(...latencies);
    const ok = failed === 0 && worst < 2000;
    g.record("H-4", {
      outcome: ok ? "pass" : "finding",
      summary: `klien lain dilayani ${latencies.length - failed} dari ${latencies.length}, latensi terburuk ${worst} ms. Setelah ${observeSeconds} dtk, ${stillOpen} dari 200 koneksi lambat masih terbuka`,
      evidence: {firstServerClose: closedAt.length ? Math.min(...closedAt) : null, closedByServer: closedAt.length},
    });
    assert.ok(ok);
  });

  test("H-5 OPTIONS and CORS headers on the new routes match the old ones", async () => {
    const routes = ["/v1/session", "/v1/intents", "/v1/intents/0x" + "ab".repeat(32), "/v1/batches/1/intents"];
    const seen = {};
    for (const path of routes) {
      const pre = await request(g.api, path, {method: "OPTIONS"});
      const plain = await get(g.api, path);
      seen[path] = {
        options: pre.status,
        allowOrigin: pre.headers?.get("access-control-allow-origin"),
        allowMethods: pre.headers?.get("access-control-allow-methods"),
        onGet: plain.headers?.get("access-control-allow-origin"),
      };
    }
    const reference = JSON.stringify({...seen["/v1/session"]});
    const differ = Object.entries(seen).filter(([, v]) => JSON.stringify({...v}) !== reference);
    g.record("H-5", {outcome: differ.length === 0 ? "pass" : "finding", summary: differ.length ? `${differ.length} rute berbeda dari /v1/session` : "sama untuk semua rute", evidence: seen});
    assert.deepEqual(differ.map(([k]) => k), []);
  });
});
