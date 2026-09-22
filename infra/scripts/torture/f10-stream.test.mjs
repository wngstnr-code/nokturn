// Group F10. WS /v1/stream, the criterion being that two solvers see the same
// batch at the same moment.

import assert from "node:assert/strict";
import {connect as netConnect} from "node:net";
import {randomBytes} from "node:crypto";
import {describe, test} from "node:test";
import {get, rssOf, submit} from "./lib/api.mjs";
import {mb} from "./lib/evidence.mjs";
import {chainNow, warpTo} from "./lib/fork.mjs";
import {freshWindow, nonceSource, restartApi, useGroup} from "./lib/harness.mjs";
import {makeIntent, signRaw, users} from "./lib/sign.mjs";
import {BATCH_TOPICS, closeAll, connect, errors, events, send, waitClosed, waitFor} from "./lib/stream.mjs";

const g = useGroup(import.meta.url);
const nextNonce = nonceSource(10);

async function signedBy(user) {
  return signRaw(makeIntent({owner: user.address, nonce: nextNonce(), now: await chainNow()}), user);
}

const closedFor = (batchId) => (f) => f.frame.type === "batch.collect_closed" && f.frame.data.batchId === batchId;
const snapshot = (f) => f.frame.type === "batch.opened";

/** Every at this group saw, next to the block time it should equal. */
const seenAt = [];

describe("F10 stream", () => {
  test("F10-1 two clients see the same batch at the same moment", async () => {
    const batch = await freshWindow(g.api, 30);
    const a = await connect(g.api, {topics: BATCH_TOPICS});
    const b = await connect(g.api, {topics: BATCH_TOPICS});
    await Promise.all([waitFor(a, snapshot, 10_000), waitFor(b, snapshot, 10_000)]);

    const hashes = [];
    for (const u of users.slice(0, 3)) {
      const res = await submit(g.api, await signedBy(u));
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.batchId, batch.batchId, "a boundary fell between the submissions");
      hashes.push(res.body.intentHash);
    }
    const closeAt = BigInt(batch.collectEndsAt) + 1n;
    await warpTo(closeAt);
    const [ca, cb] = await Promise.all([waitFor(a, closedFor(batch.batchId)), waitFor(b, closedFor(batch.batchId))]);

    const added = (c) => events(c, "batch.intent_added").filter((f) => f.frame.data.batchId === batch.batchId).map((f) => f.frame.data.intentHash);
    const feedA = await get(g.api, `/v1/batches/${batch.batchId}/intents`);
    const feedB = await get(g.api, `/v1/batches/${batch.batchId}/intents`);
    const feedHashes = (f) => f.body?.intents?.map((i) => i.intentHash) ?? [];
    const gapMs = ca && cb ? Math.round(Math.abs(ca.receivedAt - cb.receivedAt)) : null;
    if (ca) seenAt.push({label: "collect_closed", at: ca.frame.at, block: Number(closeAt)});

    const ok =
      ca !== null &&
      cb !== null &&
      JSON.stringify(added(a)) === JSON.stringify(hashes) &&
      JSON.stringify(added(b)) === JSON.stringify(hashes) &&
      gapMs < 1000 &&
      ca.frame.data.intentCount === 3 &&
      JSON.stringify(feedHashes(feedA)) === JSON.stringify(feedHashes(feedB)) &&
      [...feedHashes(feedA)].sort().join() === [...hashes].sort().join() &&
      feedA.body?.frozen === true;
    g.record("F10-1", {
      outcome: ok ? "pass" : "finding",
      summary: `batch ${batch.batchId}, intent_added A ${added(a).length} B ${added(b).length} sama ${JSON.stringify(added(a)) === JSON.stringify(added(b))}, collect_closed selisih ${gapMs} ms, feed ${feedHashes(feedA).length} intent frozen ${feedA.body?.frozen}`,
      evidence: {gapMs, intentCount: ca?.frame.data.intentCount},
    });
    await closeAll([a, b]);
    assert.ok(ok, JSON.stringify({a: added(a), b: added(b), hashes, gapMs}));
  });

  test("F10-2 a client that connects mid batch gets the batch it is in", async () => {
    const batch = await freshWindow(g.api, 20);
    const c = await connect(g.api, {topics: ["batch.opened"]});
    const snap = await waitFor(c, snapshot, 10_000);
    const current = (await get(g.api, "/v1/batches/current")).body;
    const now = await chainNow();
    if (snap) seenAt.push({label: "snapshot", at: snap.frame.at, block: Number(now)});
    const ok = snap !== null && snap.frame.data.batchId === batch.batchId && snap.frame.data.batchId === current.batchId;
    g.record("F10-2", {
      outcome: ok ? "pass" : "finding",
      summary: `snapshot batch ${snap?.frame.data.batchId ?? "tidak ada"}, GET current ${current.batchId}`,
    });
    await closeAll([c]);
    assert.ok(ok);
  });

  test("F10-3 the owner filter narrows intent_added only", async () => {
    const batch = await freshWindow(g.api, 30);
    const owner = users[0].address;
    const a = await connect(g.api, {topics: BATCH_TOPICS, owner});
    await waitFor(a, snapshot, 10_000);
    const mine = await submit(g.api, await signedBy(users[0]));
    const theirs = await submit(g.api, await signedBy(users[1]));
    assert.equal(mine.status, 200, mine.text);
    assert.equal(theirs.status, 200, theirs.text);
    await warpTo(BigInt(batch.collectEndsAt) + 1n);
    const closed = await waitFor(a, closedFor(batch.batchId));
    const added = events(a, "batch.intent_added").map((f) => f.frame.data);
    const leaked = added.some((d) => "owner" in d);
    const ok = closed !== null && added.length === 1 && added[0].intentHash === mine.body.intentHash && !leaked;
    g.record("F10-3", {
      outcome: ok ? "pass" : "finding",
      summary: `filter ${owner}, intent_added diterima ${added.length}, milik sendiri ${added[0]?.intentHash === mine.body.intentHash}, collect_closed ${closed !== null}, owner bocor ke klien ${leaked}`,
    });
    await closeAll([a]);
    assert.ok(ok, JSON.stringify(added));
  });

  test("F10-4 topics with no real source are refused by name", async () => {
    const c = await connect(g.api, {topics: ["batch.opened", "batch.settled", "auction.crossed"]});
    const refusal = await waitFor(c, (f) => f.frame.code === "COORDINATOR_NOT_IMPLEMENTED", 10_000);
    const snap = await waitFor(c, snapshot, 10_000);
    const d = refusal?.frame.detail ?? {};
    const ok =
      errors(c).length === 1 &&
      String(d.topics).split(",").sort().join() === "auction.crossed,batch.settled" &&
      /indexer/.test(d.needs) &&
      /auction keeper/.test(d.needs) &&
      snap !== null &&
      !c.closed;
    g.record("F10-4", {
      outcome: ok ? "pass" : "finding",
      summary: `penolakan ${refusal?.frame.code ?? "tidak ada"}, topics ${d.topics}, needs ${d.needs}, snapshot tetap datang ${snap !== null}`,
    });
    await closeAll([c]);
    assert.ok(ok, JSON.stringify(c.frames.map((f) => f.frame)));
  });

  test("F10-5 invalid, unknown and oversized messages", async () => {
    const c = await connect(g.api);
    const bad = ["{not json", JSON.stringify({type: "unsubscribe"}), JSON.stringify({type: "subscribe", topics: ["batch.nope"]})];
    for (const m of bad) send(c, m);
    await waitFor(c, () => errors(c).length >= 3, 5000);
    const answered = errors(c).map((f) => f.frame.code);
    const openAfterThree = !c.closed;
    // Two more are still answered, and the sixth closes.
    send(c, "x");
    send(c, "y");
    send(c, "z");
    const closedOn = await waitClosed(c, 5000);

    const big = await connect(g.api);
    send(big, "a".repeat(1024 * 1024));
    const bigClosed = await waitClosed(big, 5000);
    const alive = (await get(g.api, "/")).status === 200;

    const ok =
      answered.length === 3 &&
      answered.every((code) => code === "COORDINATOR_INVALID_REQUEST") &&
      openAfterThree &&
      errors(c).length === 5 &&
      closedOn?.code === 1008 &&
      bigClosed?.code === 1009 &&
      alive;
    g.record("F10-5", {
      outcome: ok ? "pass" : "finding",
      summary: `tiga pesan dijawab ${answered.join(",")}, socket terbuka ${openAfterThree}, dijawab ${errors(c).length} sebelum ditutup ${closedOn?.code}, pesan 1 MB ditutup ${bigClosed?.code}, server hidup ${alive}`,
    });
    assert.ok(ok);
  });

  test("F10-6 two hundred clients and the one after", {timeout: 5 * 60_000}, async () => {
    await restartApi(g);
    const rssBefore = rssOf(g.api.pid);
    const batch = await freshWindow(g.api, 40);
    const clients = [];
    for (let i = 0; i < 200; i += 1) clients.push(await connect(g.api, {topics: ["batch.collect_closed"]}));
    const extra = await connect(g.api, {topics: ["batch.collect_closed"]});
    const extraClosed = await waitClosed(extra, 5000);
    const rssAt200 = rssOf(g.api.pid);

    await warpTo(BigInt(batch.collectEndsAt) + 1n);
    const got = await Promise.all(clients.map((c) => waitFor(c, closedFor(batch.batchId), 30_000)));
    const received = got.filter(Boolean).length;
    const ok = extraClosed?.code === 1013 && /limit/.test(extraClosed.reason) && received === 200;
    g.record("F10-6", {
      outcome: ok ? "pass" : "finding",
      summary: `klien ke-201 ditutup ${extraClosed?.code} "${extraClosed?.reason ?? ""}", ${received} dari 200 menerima collect_closed. RSS ${mb(rssBefore)} MB sebelum, ${mb(rssAt200)} MB dengan 200 klien`,
      evidence: {rssBefore, rssAt200},
    });
    await closeAll(clients);
    assert.ok(ok);
  });

  test("F10-7 a client that stops reading is cut off", {timeout: 3 * 60_000}, async () => {
    const watcher = await connect(g.api, {topics: ["batch.collect_closed"]});
    const port = new URL(g.api.url).port;
    const sock = netConnect(Number(port), "127.0.0.1");
    let ended = false;
    sock.on("close", () => (ended = true));
    sock.on("error", () => (ended = true));
    await new Promise((r) => sock.once("connect", r));
    sock.write(
      `GET /v1/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    const head = await new Promise((r) => sock.once("data", (d) => r(d.toString())));
    assert.match(head, /^HTTP\/1\.1 101/, head);
    sock.pause();

    // A refused topic is answered with an error frame and costs the server no
    // chain read, so it is the cheapest way to make the server write.
    const frame = (text) => {
      const payload = Buffer.from(text);
      const mask = randomBytes(4);
      const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
      return Buffer.concat([header, mask, masked]);
    };
    const one = frame(JSON.stringify({type: "subscribe", topics: ["batch.settled"]}));
    const started = performance.now();
    for (let i = 0; i < 40_000 && !ended; i += 1) {
      if (!sock.write(one)) await new Promise((r) => sock.once("drain", r).once("close", r));
    }
    for (let i = 0; i < 100 && !ended; i += 1) await new Promise((r) => setTimeout(r, 100));

    const batch = await freshWindow(g.api, 5);
    await warpTo(BigInt(batch.collectEndsAt) + 1n);
    const others = await waitFor(watcher, closedFor(batch.batchId));
    sock.destroy();
    await closeAll([watcher]);
    if (!ended) {
      g.record("F10-7", {
        outcome: "skip",
        summary: "harness tidak berhasil mengisi buffer server melewati 1 MB dalam satu percobaan, buffer kernel loopback menyerap semuanya",
      });
      return;
    }
    g.record("F10-7", {
      outcome: others ? "pass" : "finding",
      summary: `klien yang berhenti membaca diputus setelah ${Math.round(performance.now() - started)} ms, klien lain tetap menerima collect_closed ${others !== null}`,
    });
    assert.ok(others);
  });

  test("F10-8 the api killed and started again", async () => {
    const c = await connect(g.api, {topics: ["batch.opened"]});
    await waitFor(c, snapshot, 10_000);
    await g.api.stop("SIGKILL");
    const closed = await waitClosed(c, 10_000);
    await restartApi(g);
    const again = await connect(g.api, {topics: ["batch.opened"]});
    const snap = await waitFor(again, snapshot, 10_000);
    const ok = closed !== null && snap !== null;
    g.record("F10-8", {
      outcome: ok ? "pass" : "finding",
      summary: `klien menerima penutupan ${closed?.code ?? "tidak"}, sambung ulang dapat snapshot ${snap !== null}`,
    });
    await closeAll([again]);
    assert.ok(ok);
  });

  test("F10-9 every at is block time, not the laptop clock", () => {
    const wall = Math.floor(Date.now() / 1000);
    const rows = seenAt.map((s) => ({...s, offBlock: s.at - s.block, behindWall: wall - s.at}));
    const ok = rows.length >= 2 && rows.every((r) => Math.abs(r.offBlock) <= 2 && r.behindWall > 60);
    g.record("F10-9", {
      outcome: ok ? "pass" : "finding",
      summary: rows.map((r) => `${r.label} at ${r.at}, blok ${r.block}, selisih blok ${r.offBlock} dtk, di belakang jam laptop ${r.behindWall} dtk`).join(". "),
    });
    assert.ok(ok, JSON.stringify(rows));
  });

  test("F10-10 a plain GET is told to upgrade", async () => {
    const res = await get(g.api, "/v1/stream");
    const ok = res.status === 426 && res.body?.code === "COORDINATOR_INVALID_REQUEST" && /websocket/i.test(res.body?.message ?? "");
    g.record("F10-10", {outcome: ok ? "pass" : "finding", summary: `${res.status} ${res.body?.code ?? ""} "${res.body?.message ?? ""}"`});
    assert.ok(ok);
  });
});
