// Group L. Load. Every number here is one laptop against a fork, recorded as
// measured, including the bad ones. None of it belongs in a pitch.
//
// L-1 uses autocannon, because a fake signature is one body repeated. L-2 to
// L-5 need a distinct validly signed intent on every request, which autocannon
// cannot produce from its command line, so they use the generator below.

import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {describe, test} from "node:test";
import {get, percentile, rssOf, submit} from "./lib/api.mjs";
import {EVIDENCE_DIR, mb} from "./lib/evidence.mjs";
import {chainNow, warpTo} from "./lib/fork.mjs";
import {currentBatch, freshWindow, nonceSource, useGroup} from "./lib/harness.mjs";
import {makeIntent, signRaw, users} from "./lib/sign.mjs";

const g = useGroup(import.meta.url);
const nextNonce = nonceSource(5);
const SECONDS = Number(process.env.NOKTURN_TORTURE_LOAD_SECONDS ?? 60);

/**
 * Keeps `workers` requests in flight for `seconds`, each carrying a freshly
 * signed intent from one of the four demo users with a nonce nobody else uses.
 */
async function generate({workers, seconds, onAnswer}) {
  const answers = [];
  const now = await chainNow();
  const until = performance.now() + seconds * 1000;
  const started = performance.now();
  await Promise.all(
    Array.from({length: workers}, async (_, w) => {
      let i = 0;
      while (performance.now() < until) {
        const u = users[(w + i++) % users.length];
        const s = await signRaw(makeIntent({owner: u.address, nonce: nextNonce(), now}), u);
        const sentAt = performance.now();
        const res = await submit(g.api, s, {timeoutMs: 60_000});
        const a = {status: res.status, code: res.body?.code, ms: res.ms, batchId: res.body?.batchId, hash: res.body?.intentHash, sentAt, doneAt: performance.now()};
        answers.push(a);
        onAnswer?.(a);
      }
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  const classes = {};
  for (const a of answers) {
    const key = a.status === 0 ? "client timeout" : `${a.status} ${a.code ?? ""}`.trim();
    classes[key] = (classes[key] ?? 0) + 1;
  }
  const latencies = answers.map((a) => a.ms);
  return {
    answers,
    classes,
    rps: Math.round((answers.length / elapsed) * 10) / 10,
    p50: percentile(latencies, 50),
    p99: percentile(latencies, 99),
  };
}

async function feedHashes(batchId) {
  const res = await get(g.api, `/v1/batches/${batchId}/intents`);
  return res.status === 200 ? res.body.intents.map((i) => i.intentHash) : null;
}

function runAutocannon(args) {
  return new Promise((resolve) => {
    execFile("pnpm", ["dlx", "autocannon", ...args], {shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000}, (error, stdout, stderr) => {
      resolve({code: error?.code ?? 0, stdout, stderr});
    });
  });
}

describe("L load", () => {
  test("L-1 500 connections of fake signatures through autocannon", {timeout: 15 * 60_000}, async () => {
    const now = await chainNow();
    const body = JSON.stringify({intent: makeIntent({owner: users[0].address, nonce: 1n, now}), signature: `0x${"11".repeat(32)}${"22".repeat(32)}1b`});
    const bodyFile = join(EVIDENCE_DIR, "l1-body.json");
    writeFileSync(bodyFile, body);
    const rssBefore = rssOf(g.api.pid);
    const run = await runAutocannon(["-c", "500", "-d", String(SECONDS), "-m", "POST", "-H", "content-type=application/json", "-i", bodyFile, "-j", `${g.api.url}/v1/intents`]);
    const rssAfter = rssOf(g.api.pid);
    let r;
    try {
      r = JSON.parse(run.stdout);
    } catch {
      r = null;
    }
    assert.ok(r, `autocannon did not produce JSON: ${run.stderr.slice(-500)}`);
    const codes = r.statusCodeStats ?? {};
    const non401 = Object.entries(codes).filter(([code]) => code !== "401").reduce((n, [, v]) => n + v.count, 0);
    const five = Object.entries(codes).filter(([code]) => code.startsWith("5")).reduce((n, [, v]) => n + v.count, 0);
    g.record("L-1", {
      outcome: five === 0 ? "measure" : "finding",
      summary: `${r.requests.average} rps rata rata, p99 ${r.latency.p99} ms, ${r.errors} error koneksi, ${r.timeouts} timeout, ${non401} jawaban selain 401, ${five} 5xx. RSS ${mb(rssBefore)} MB lalu ${mb(rssAfter)} MB`,
      evidence: {statusCodes: Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, v.count])), total: r.requests.total},
    });
    assert.equal(five, 0);
  });

  test("L-2 100 connections of valid intents, intentCount matches every 200", {timeout: 15 * 60_000}, async () => {
    await freshWindow(g.api, 5);
    const run = await generate({workers: 100, seconds: SECONDS});
    const perBatch = {};
    for (const a of run.answers) if (a.status === 200) perBatch[a.batchId] = (perBatch[a.batchId] ?? 0) + 1;
    const mismatches = [];
    for (const [batchId, count] of Object.entries(perBatch)) {
      const served = await feedHashes(batchId);
      if (served?.length !== count) mismatches.push({batchId, accepted: count, served: served?.length});
    }
    const accepted = run.answers.filter((a) => a.status === 200).length;
    g.record("L-2", {
      outcome: mismatches.length === 0 ? "pass" : "finding",
      summary: `${run.rps} rps, p50 ${run.p50} ms, p99 ${run.p99} ms, ${accepted} diterima di ${Object.keys(perBatch).length} batch, ${mismatches.length} batch selisih`,
      evidence: {classes: run.classes, mismatches},
    });
    assert.deepEqual(mismatches, []);
  });

  test("L-3 L-2 while twenty solvers poll the feed every 100 ms", {timeout: 15 * 60_000}, async () => {
    await freshWindow(g.api, 5);
    const polls = [];
    let stop = false;
    const pollers = Array.from({length: 20}, async () => {
      while (!stop) {
        const startedAt = performance.now();
        const cur = await get(g.api, "/v1/batches/current");
        if (cur.body?.batchId) {
          const feed = await get(g.api, `/v1/batches/${cur.body.batchId}/intents`);
          if (feed.status === 200) polls.push({startedAt, batchId: cur.body.batchId, hashes: new Set(feed.body.intents.map((i) => i.intentHash)), ms: feed.ms});
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    const run = await generate({workers: 100, seconds: SECONDS});
    stop = true;
    await Promise.all(pollers);
    polls.sort((a, b) => a.startedAt - b.startedAt);
    const missed = [];
    for (const a of run.answers.filter((x) => x.status === 200)) {
      const next = polls.find((p) => p.startedAt > a.doneAt && p.batchId === a.batchId);
      if (next && !next.hashes.has(a.hash)) missed.push(a.hash);
    }
    g.record("L-3", {
      outcome: missed.length === 0 ? "pass" : "finding",
      summary: `${run.rps} rps intent, ${polls.length} polling feed, latensi feed p50 ${percentile(polls.map((p) => p.ms), 50)} ms p99 ${percentile(polls.map((p) => p.ms), 99)} ms, ${missed.length} intent tidak muncul di polling berikutnya`,
      evidence: {classes: run.classes},
    });
    assert.deepEqual(missed, []);
  });

  test("L-4 L-2 across ten batch boundaries", {timeout: 15 * 60_000}, async () => {
    await freshWindow(g.api, 5);
    const captured = new Map();
    const seenBatches = [];
    let stop = false;
    const mover = (async () => {
      for (let i = 0; i < 10 && !stop; i += 1) {
        await new Promise((r) => setTimeout(r, 5000));
        const cur = await currentBatch(g.api);
        seenBatches.push(cur.batchId);
        await warpTo(BigInt(cur.collectEndsAt) + 1n);
        // A batch is forgotten 310 seconds after it closes, which is five warps
        // from now, so each one is captured two warps after it closed.
        const old = seenBatches.at(-3);
        if (old && !captured.has(old)) captured.set(old, await feedHashes(old));
      }
    })();
    const run = await generate({workers: 100, seconds: 55});
    stop = true;
    await mover;
    const accepted = run.answers.filter((a) => a.status === 200);
    for (const id of new Set(accepted.map((a) => a.batchId))) if (!captured.has(id)) captured.set(id, await feedHashes(id));
    const where = new Map();
    for (const [batchId, hashes] of captured) for (const h of hashes ?? []) where.set(h, [...(where.get(h) ?? []), batchId]);
    const wrong = accepted.filter((a) => {
      const w = where.get(a.hash) ?? [];
      return w.length !== 1 || w[0] !== a.batchId;
    });
    const lost = [...captured].filter(([, h]) => h === null).map(([id]) => id);
    g.record("L-4", {
      outcome: wrong.length === 0 ? "pass" : "finding",
      summary: `${accepted.length} diterima di ${new Set(accepted.map((a) => a.batchId)).size} batch melintasi ${seenBatches.length} batas, ${wrong.length} intent tidak berada tepat di batch respons POST-nya`,
      evidence: {lostFeeds: lost, sample: wrong.slice(0, 3).map((a) => ({hash: a.hash, said: a.batchId, found: where.get(a.hash)}))},
    });
    assert.deepEqual(wrong.map((a) => a.hash), []);
  });

  test("L-5 ramping load to find where the fork saturates", {timeout: 20 * 60_000}, async () => {
    const steps = [];
    for (const workers of [10, 25, 50, 100, 200, 400]) {
      await freshWindow(g.api, 5);
      const run = await generate({workers, seconds: 15});
      const errors = run.answers.filter((a) => a.status !== 200).length;
      steps.push({workers, rps: run.rps, p50: run.p50, p99: run.p99, errors});
    }
    const peak = steps.reduce((a, b) => (b.rps > a.rps ? b : a));
    g.record("L-5", {
      outcome: "measure",
      summary: `puncak ${peak.rps} rps pada ${peak.workers} koneksi. ${steps.map((s) => `${s.workers}k ${s.rps}rps p99 ${s.p99}ms err ${s.errors}`).join("; ")}`,
      evidence: {steps},
    });
  });
});
