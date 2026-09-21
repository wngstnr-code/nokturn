// Group S. Durability over a long run, make torture-soak.
//
// Five valid intents a second, chain time moved one batch every ten seconds,
// the API killed with SIGKILL every fifteen minutes, and the node made to hang
// once. The length defaults to two hours and is read from
// NOKTURN_TORTURE_SOAK_MINUTES so the harness itself can be tried short.

import assert from "node:assert/strict";
import {before, describe, test} from "node:test";
import {get, rssOf, startApi, submit} from "./lib/api.mjs";
import {mb} from "./lib/evidence.mjs";
import {chainNow, ethCall, warpTo} from "./lib/fork.mjs";
import {currentBatch, nonceSource, useGroup} from "./lib/harness.mjs";
import {ctx, makeIntent, signRaw, users} from "./lib/sign.mjs";

const g = useGroup(import.meta.url, {proxy: true});
const nextNonce = nonceSource(6);

const MINUTES = Number(process.env.NOKTURN_TORTURE_SOAK_MINUTES ?? 120);
const RESTART_EVERY_MIN = Math.min(15, MINUTES / 4);
const HANG_AT_MIN = MINUTES * 0.375;
const HANG_FOR_MS = Math.min(120_000, (MINUTES * 60_000) / 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsedMin = (t0) => (performance.now() - t0) / 60_000;

/** Filled by the one soak run in before, read by the four tests below. */
const result = {};

describe("S soak", () => {
  before(async () => {
    const t0 = performance.now();
    const until = t0 + MINUTES * 60_000;
    const samples = [];
    const restarts = [];
    const hang = {};
    const counts = {accepted: 0, other: {}};
    let live = [];
    let epoch = 0;
    let paused = false;

    const sender = (async () => {
      let i = 0;
      while (performance.now() < until) {
        const tick = performance.now();
        if (!paused) {
          const u = users[i++ % users.length];
          const s = await signRaw(makeIntent({owner: u.address, nonce: nextNonce(), now: await chainNow()}), u);
          const res = await submit(g.api, s, {timeoutMs: 60_000});
          if (res.status === 200) {
            counts.accepted += 1;
            live.push({s, hash: res.body.intentHash, epoch});
            if (live.length > 400) live = live.slice(-200);
          } else {
            const key = res.status === 0 ? "client timeout" : `${res.status} ${res.body?.code ?? ""}`;
            counts.other[key] = (counts.other[key] ?? 0) + 1;
          }
        }
        await sleep(Math.max(0, 200 - (performance.now() - tick)));
      }
    })();

    const mover = (async () => {
      while (performance.now() < until) {
        await sleep(10_000);
        if (paused) continue;
        try {
          const cur = await currentBatch(g.api);
          await warpTo(BigInt(cur.batchId === null ? cur.chainTime + 60 : cur.collectEndsAt) + 1n);
        } catch {
          // the API is restarting or the node is hanging, try again next tick
        }
      }
    })();

    // A sample taken while the API is between a kill and its restart reads a pid
    // that no longer exists, so it is skipped rather than recorded as zero.
    const sampler = (async () => {
      while (performance.now() < until) {
        const alive = !paused && g.api.proc.exitCode === null && g.api.proc.signalCode === null;
        const rss = alive ? rssOf(g.api.pid) : 0;
        if (rss > 0) samples.push({minute: Math.round(elapsedMin(t0)), epoch, rss, accepted: counts.accepted});
        await sleep(60_000);
      }
    })();

    const chaos = (async () => {
      let nextRestart = RESTART_EVERY_MIN;
      let hung = false;
      while (performance.now() < until) {
        await sleep(5_000);
        const m = elapsedMin(t0);
        if (!hung && m >= HANG_AT_MIN) {
          hung = true;
          // RSS swings by half inside one process lifetime on its own, measured
          // 21 September 2026, so the line to come back to is the highest this
          // process reached before the hang, not one sample.
          hang.rssBefore = Math.max(rssOf(g.api.pid), ...samples.filter((s) => s.epoch === epoch).map((s) => s.rss));
          g.proxy.setRules([{mode: "hang"}]);
          await sleep(HANG_FOR_MS);
          g.proxy.pass();
          g.proxy.releaseHung();
          const back = performance.now();
          let ok = false;
          while (!ok && performance.now() - back < 60_000) {
            const u = users[0];
            const res = await submit(g.api, await signRaw(makeIntent({owner: u.address, nonce: nextNonce(), now: await chainNow()}), u), {timeoutMs: 30_000});
            ok = res.status === 200;
            if (!ok) await sleep(500);
          }
          hang.recoveredMs = ok ? Math.round(performance.now() - back) : null;
          await sleep(Math.min(180_000, until - performance.now()));
          hang.rssAfter = rssOf(g.api.pid);
        }
        if (m >= nextRestart && until - performance.now() > 60_000) {
          // Counted from this restart, so a long hang does not queue up two.
          nextRestart = m + RESTART_EVERY_MIN;
          paused = true;
          const before = live.slice(-20);
          await g.api.stop("SIGKILL");
          const spawned = performance.now();
          g.api = await startApi({rpc: g.proxy.url});
          const bootMs = Math.round(performance.now() - spawned);
          epoch += 1;
          live = [];
          const old = before[0];
          const lookup = old ? await get(g.api, `/v1/intents/${old.hash}`) : null;
          const resubmit = old ? await submit(g.api, old.s) : null;
          let escapesOk = 0;
          for (const b of before) {
            const esc = await ethCall({from: b.s.intent.owner, to: ctx.deployment.settlement, data: await escapeData(b.s)}).then(() => true, () => false);
            if (esc) escapesOk += 1;
          }
          restarts.push({minute: Math.round(m), bootMs, oldLookup: lookup?.status, resubmit: resubmit?.status, escapes: `${escapesOk}/${before.length}`});
          paused = false;
        }
      }
    })();

    await Promise.all([sender, mover, sampler, chaos]);

    // S-1. Memory within each process lifetime, after its warm up. A least
    // squares slope rather than first against last sample, because single
    // samples swing by half on their own.
    const slopes = [];
    for (let e = 0; e <= epoch; e += 1) {
      const inEpoch = samples.filter((s) => s.epoch === e);
      const settled = inEpoch.slice(Math.min(5, Math.floor(inEpoch.length / 3)));
      if (settled.length < 3) continue;
      const mx = settled.reduce((a, s) => a + s.accepted, 0) / settled.length;
      const my = settled.reduce((a, s) => a + s.rss, 0) / settled.length;
      const sxy = settled.reduce((a, s) => a + (s.accepted - mx) * (s.rss - my), 0);
      const sxx = settled.reduce((a, s) => a + (s.accepted - mx) ** 2, 0);
      if (sxx > 0) slopes.push(Math.round(sxy / sxx));
    }
    const medianSlope = slopes.length ? [...slopes].sort((a, b) => a - b)[Math.floor(slopes.length / 2)] : null;
    const flat = medianSlope !== null && medianSlope < 1000;
    g.record("S-1", {
      outcome: medianSlope === null ? "skip" : flat ? "pass" : "finding",
      suspect: "D6",
      summary: `${counts.accepted} intent diterima dalam ${MINUTES} menit. Kenaikan RSS per intent per umur proses ${slopes.join(", ")} byte, median ${medianSlope}`,
      evidence: {other: counts.other, samples: samples.map((s) => `m${s.minute}/e${s.epoch}:${mb(s.rss)}MB`)},
    });

    // S-2 and S-3.
    const slowBoot = restarts.filter((r) => r.bootMs > 5000);
    const lookupWrong = restarts.filter((r) => r.oldLookup !== 404);
    const resubmitWrong = restarts.filter((r) => r.resubmit !== 200);
    const escapeWrong = restarts.filter((r) => !/^(\d+)\/\1$/.test(r.escapes));
    g.record("S-2", {
      outcome: slowBoot.length + lookupWrong.length + resubmitWrong.length === 0 && restarts.length > 0 ? "pass" : "finding",
      summary: `${restarts.length} kali SIGKILL. Boot terlama ${Math.max(0, ...restarts.map((r) => r.bootMs))} ms. Intent lama 404 di ${restarts.length - lookupWrong.length}, kirim ulang diterima di ${restarts.length - resubmitWrong.length}`,
      evidence: {restarts},
    });
    g.record("S-3", {
      outcome: escapeWrong.length === 0 && restarts.length > 0 ? "pass" : "finding",
      summary: `escape hatch intent dari sebelum restart tetap sah: ${restarts.map((r) => r.escapes).join(", ")}`,
    });

    // S-4.
    const rssBack = hang.rssBefore && hang.rssAfter ? hang.rssAfter <= hang.rssBefore * 1.2 : false;
    g.record("S-4", {
      outcome: hang.recoveredMs !== null && hang.recoveredMs !== undefined && rssBack ? "pass" : "finding",
      summary: `node menggantung ${HANG_FOR_MS / 1000} dtk, request sah pertama sesudahnya ${hang.recoveredMs ?? "tidak pernah"} ms, RSS ${mb(hang.rssBefore ?? 0)} MB lalu ${mb(hang.rssAfter ?? 0)} MB`,
    });

    Object.assign(result, {
      medianSlope,
      flat,
      restarts: restarts.length,
      restartWrong: slowBoot.length + lookupWrong.length + resubmitWrong.length,
      escapeWrong: escapeWrong.length,
      recovered: hang.recoveredMs !== null && hang.recoveredMs !== undefined,
      rssBack,
    });
  }, {timeout: (MINUTES + 20) * 60_000});

  test(`S-1 memory over ${MINUTES} minutes`, {todo: "KEPUTUSAN D6"}, () => {
    assert.ok(result.medianSlope !== null, "too few samples per process lifetime to measure, run longer");
    assert.ok(result.flat, "memory keeps growing within a process lifetime");
  });

  test("S-2 SIGKILL and restart", () => {
    assert.ok(result.restarts > 0, "no restart happened");
    assert.equal(result.restartWrong, 0);
  });

  test("S-3 escape hatches survive a restart", () => {
    assert.ok(result.restarts > 0, "no restart happened");
    assert.equal(result.escapeWrong, 0);
  });

  test("S-4 recovery from a hung node", () => {
    assert.ok(result.recovered, "no valid request succeeded after the hang");
    assert.ok(result.rssBack, "memory did not come back to the line before the hang");
  });
});

async function escapeData(signed) {
  const res = await fetch(`${g.api.url}/v1/intents/escape`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({intent: signed.intent, signature: signed.signature}),
  });
  return (await res.json()).data;
}
