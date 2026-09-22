// Group C1. The mempool, commit 50c819f.

import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {get, rssOf, submit} from "./lib/api.mjs";
import {mb} from "./lib/evidence.mjs";
import {chainNow, warpTo} from "./lib/fork.mjs";
import {currentBatch, freshWindow, nonceSource, pool, restartApi, useGroup} from "./lib/harness.mjs";
import {makeIntent, signRaw, users} from "./lib/sign.mjs";

const g = useGroup(import.meta.url);
const nextNonce = nonceSource(1);

async function signFor(user, fields = {}) {
  const now = await chainNow();
  return signRaw(makeIntent({owner: user.address, nonce: fields.nonce ?? nextNonce(), now, ...fields}), user);
}

/** What GET /v1/nonces suggests right now for this owner. */
async function suggestedNonce(user) {
  const res = await get(g.api, `/v1/nonces/${user.address}`);
  assert.equal(res.status, 200, res.text);
  return res.body.next;
}

describe("C1 mempool", () => {
  test("C1-1 two identical POSTs in flight together, 50 pairs", async () => {
    const outcomes = [];
    for (let i = 0; i < 50; i += 1) {
      const s = await signFor(users[i % users.length]);
      const [a, b] = await Promise.all([submit(g.api, s), submit(g.api, s)]);
      outcomes.push([a.status, b.status].sort().join("/"));
    }
    const bad = outcomes.filter((o) => o !== "200/409");
    g.record("C1-1", {
      outcome: bad.length === 0 ? "pass" : "finding",
      summary: `${outcomes.length - bad.length} dari 50 pasang tepat satu 200 dan satu 409`,
      evidence: {bad},
    });
    assert.deepEqual(bad, []);
  });

  test("C1-2 one nonce written three ways", async () => {
    const n = nextNonce();
    const spellings = [String(n), `0${n}`, `0x${n.toString(16)}`];
    const answers = [];
    for (const [i, nonce] of spellings.entries()) {
      const s = await signFor(users[0], {nonce, minBuyAmount: String(1 + i)});
      const res = await submit(g.api, s);
      answers.push({nonce, status: res.status, code: res.body?.code});
    }
    const ok = answers[0].status === 200 && answers.slice(1).every((a) => a.status === 409 || a.status === 400);
    g.record("C1-2", {
      outcome: ok ? "pass" : "finding",
      suspect: "D1",
      summary: answers.map((a) => `${a.nonce} ${a.status}`).join(", "),
      evidence: {answers},
    });
    assert.ok(ok, JSON.stringify(answers));
  });

  test("C1-3 the solver feed serves the canonical intent", async () => {
    // A hex nonce was the original probe here. Since D3 it is a 400 before the
    // mempool sees it, so the non canonical input is a narrow field sent as a
    // string, which IntentPayload says is a number.
    const n = nextNonce();
    const s = await signFor(users[1], {nonce: String(n), flags: "1"});
    const res = await submit(g.api, {...s, intent: {...s.intent, evil: "x".repeat(500_000)}});
    assert.equal(res.status, 200, res.text);
    const feed = await get(g.api, `/v1/batches/${res.body.batchId}/intents`);
    assert.equal(feed.status, 200, feed.text);
    const served = feed.body.intents.find((i) => i.intentHash === res.body.intentHash)?.intent;
    const ok = served && !("evil" in served) && served.nonce === String(n) && served.flags === 1;
    g.record("C1-3", {
      outcome: ok ? "pass" : "finding",
      suspect: "D2",
      summary: ok ? "feed kanonik" : "feed menyajikan payload mentah dari klien",
      evidence: {servedKeys: served ? Object.keys(served) : null, servedNonce: served?.nonce, servedFlags: served?.flags, feedBytes: feed.text.length},
    });
    assert.ok(ok);
  });

  // C1-4 to C1-6 share one batch and run in order.
  const shared = {};

  test("C1-4 counts and batchId agree across routes", async () => {
    await restartApi(g);
    const before = await freshWindow(g.api, 30);
    shared.reusedNonce = await suggestedNonce(users[1]);
    const signed = [
      await signFor(users[0]),
      await signFor(users[0]),
      await signFor(users[1], {nonce: shared.reusedNonce}),
    ];
    const answers = [];
    for (const s of signed) answers.push(await submit(g.api, s));
    const after = await currentBatch(g.api);
    shared.hashes = answers.map((a) => a.body?.intentHash);
    shared.batch = after;

    const ids = new Set(answers.map((a) => a.body?.batchId));
    const ok =
      answers.every((a) => a.status === 200) &&
      ids.size === 1 &&
      ids.has(after.batchId) &&
      before.intentCount === 0 &&
      after.intentCount === 3 &&
      after.participantCount === 2;
    g.record("C1-4", {
      outcome: ok ? "pass" : "finding",
      summary: `intentCount ${before.intentCount} lalu ${after.intentCount}, participantCount ${after.participantCount}, batchId ${[...ids].join(",")} vs ${after.batchId}`,
      evidence: {statuses: answers.map((a) => a.status)},
    });
    assert.ok(ok);
  });

  test("C1-5 a swept batch leaves its intents expired, not missing", async () => {
    assert.ok(shared.batch, "C1-4 did not run");
    await warpTo(BigInt(shared.batch.solveEndsAt) + 301n);
    await currentBatch(g.api);
    const statuses = [];
    for (const h of shared.hashes) statuses.push((await get(g.api, `/v1/intents/${h}`)).body?.status);
    const feed = await get(g.api, `/v1/batches/${shared.batch.batchId}/intents`);
    const ok = statuses.every((s) => s === "expired") && feed.body?.intents?.length === 0;
    g.record("C1-5", {
      outcome: ok ? "pass" : "finding",
      summary: `status ${statuses.join(",")}, feed lama ${feed.body?.intents?.length} intent`,
      evidence: {statuses, feedStatus: feed.status},
    });
    assert.ok(ok);
  });

  test("C1-6 the nonce GET /v1/nonces suggests after expiry is accepted", async () => {
    assert.ok(shared.reusedNonce !== undefined, "C1-4 did not run");
    const suggested = await suggestedNonce(users[1]);
    const res = await submit(g.api, await signFor(users[1], {nonce: suggested, minBuyAmount: "2"}));
    const ok = res.status === 200;
    g.record("C1-6", {
      outcome: ok ? "pass" : "finding",
      suspect: "D5",
      summary: `nonces menyarankan ${suggested} (dipakai intent kedaluwarsa: ${suggested === shared.reusedNonce}), POST menjawab ${res.status} ${res.body?.code ?? ""}`,
      evidence: {suggested, reusedNonce: shared.reusedNonce, answer: res.body},
    });
    assert.ok(ok, `${res.status} ${res.text}`);
  });

  test("C1-6b a swept batch does not free a nonce whose intent is still valid", async () => {
    assert.ok(shared.reusedNonce !== undefined, "C1-4 did not run");
    // C1-4 signed reusedNonce with validUntil thirty days out, and C1-5 swept
    // its batch. Permit2 would still accept that signature, so the nonce is held.
    const suggested = await suggestedNonce(users[1]);
    const res = await submit(g.api, await signFor(users[1], {nonce: shared.reusedNonce, minBuyAmount: "3"}));
    const ok = suggested !== shared.reusedNonce && res.status === 409 && res.body?.code === "COORDINATOR_DUPLICATE_INTENT";
    g.record("C1-6b", {
      outcome: ok ? "pass" : "finding",
      suspect: "D5",
      summary: `nonce ${shared.reusedNonce} masih dipegang, nonces menyarankan ${suggested}, POST ulang menjawab ${res.status} ${res.body?.code ?? ""}`,
    });
    assert.ok(ok, `${suggested} ${res.status} ${res.text}`);
  });

  test("C1-6c a nonce comes free once chain time passes validUntil", async () => {
    const user = users[3];
    const batch = await freshWindow(g.api, 20);
    const nonce = await suggestedNonce(user);
    const validUntil = batch.collectEndsAt + 5;
    const first = await submit(g.api, await signFor(user, {nonce, validUntil: String(validUntil)}));
    assert.equal(first.status, 200, first.text);
    const whileHeld = await suggestedNonce(user);
    await warpTo(BigInt(validUntil) + 1n);
    const afterExpiry = await suggestedNonce(user);
    const again = await submit(g.api, await signFor(user, {nonce, minBuyAmount: "2"}));
    const ok = whileHeld !== nonce && afterExpiry === nonce && again.status === 200;
    g.record("C1-6c", {
      outcome: ok ? "pass" : "finding",
      suspect: "D5",
      summary: `nonce ${nonce}, selama dipegang disarankan ${whileHeld}, setelah validUntil ${validUntil} lewat disarankan ${afterExpiry}, POST ulang ${again.status} ${again.body?.code ?? ""}`,
    });
    assert.ok(ok, `${whileHeld} ${afterExpiry} ${again.status} ${again.text}`);
  });

  test("C1-7 memory across 20000 intents in 200 batches", {timeout: 60 * 60_000, todo: "KEPUTUSAN D6"}, async () => {
    const api = await restartApi(g);
    const total = Number(process.env.NOKTURN_TORTURE_C17_TOTAL ?? 20_000);
    const perBatch = 100;
    const samples = [{accepted: 0, rss: rssOf(api.pid)}];
    let accepted = 0;
    const failures = {};
    const now = await chainNow();

    for (let b = 0; b < total / perBatch; b += 1) {
      const batch = await freshWindow(api, 25);
      const signed = [];
      for (let i = 0; i < perBatch; i += 1) {
        const u = users[i % users.length];
        signed.push(await signRaw(makeIntent({owner: u.address, nonce: nextNonce(), now}), u));
      }
      const answers = await pool(signed, 16, (s) => submit(api, s));
      for (const a of answers) {
        if (a.status === 200) accepted += 1;
        else failures[`${a.status} ${a.body?.code}`] = (failures[`${a.status} ${a.body?.code}`] ?? 0) + 1;
      }
      if (accepted % 1000 < perBatch) samples.push({accepted, rss: rssOf(api.pid), batch: batch.batchId});
      await warpTo(BigInt(batch.collectEndsAt) + 1n);
    }
    // Let the sweep run once more, so every batch but the last is forgotten.
    await warpTo((await chainNow()) + 400n);
    await currentBatch(api);
    samples.push({accepted, rss: rssOf(api.pid), swept: true});

    // The first thousand intents grow V8's heap to its working size, which is not
    // a leak, so growth is measured from the sample after that warm up.
    const warm = samples[1];
    const half = samples.slice(Math.floor(samples.length / 2));
    const slope = (half.at(-1).rss - half[0].rss) / Math.max(1, half.at(-1).accepted - half[0].accepted);
    const perIntent = (samples.at(-1).rss - warm.rss) / Math.max(1, accepted - warm.accepted);
    const flat = slope < 200;
    g.record("C1-7", {
      outcome: flat ? "pass" : "finding",
      suspect: "D6",
      summary: `${accepted} diterima, RSS ${mb(samples[0].rss)} MB, ${mb(warm.rss)} MB setelah pemanasan, ${mb(samples.at(-1).rss)} MB di akhir setelah sapuan. ${Math.round(perIntent)} byte per intent setelah pemanasan, kemiringan paruh kedua ${Math.round(slope)} byte per intent`,
      evidence: {failures, samples: samples.map((s) => `${s.accepted}:${mb(s.rss)}MB`)},
    });
    assert.ok(flat, `RSS keeps growing at ${Math.round(slope)} bytes per intent after sweeps`);
  });

  test("C1-8 status of an old intent after 30 idle batches", async () => {
    const api = await restartApi(g);
    const batch = await freshWindow(api, 20);
    const res = await submit(api, await signFor(users[2]));
    assert.equal(res.status, 200, res.text);
    await warpTo(BigInt(batch.collectEndsAt) + BigInt(30 * (batch.collectEndsAt - batch.collectStartsAt)));
    const status = await get(api, `/v1/intents/${res.body.intentHash}`);
    const ok = status.body?.status === "expired";
    g.record("C1-8", {
      outcome: ok ? "pass" : "finding",
      suspect: "D6",
      summary: `setelah 30 batch tanpa request, status dilaporkan ${status.body?.status}`,
      evidence: {batchId: res.body.batchId, chainTime: String(await chainNow())},
    });
    assert.ok(ok);
  });
});
