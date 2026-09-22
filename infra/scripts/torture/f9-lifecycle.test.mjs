// Group F9. The batch lifecycle, heard through WS /v1/stream.
//
// Tests run in the order written. The weekend the fork is pinned on comes
// first, then the calendar walks into a weekday, because chain time only moves
// forward inside a group.

import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {encodeFunctionData, keccak256, toHex} from "viem";
import {get} from "./lib/api.mjs";
import {SESSION, findSessionStart, nextTransition} from "./lib/calendar.mjs";
import {chainNow, revert, sendAs, snapshot, warpTo, withSnapshot} from "./lib/fork.mjs";
import {currentBatch, manualMining, restartApi, useGroup} from "./lib/harness.mjs";
import {abis, ctx} from "./lib/sign.mjs";
import {LIVE_TOPICS, closeAll, connect, events, waitFor} from "./lib/stream.mjs";

const g = useGroup(import.meta.url, {proxy: true});

/** The lifecycle's own debug lines, which is where reads and tracked batches show. */
function ticks() {
  const out = [];
  for (const line of g.api.logs) {
    if (!line.includes('"lifecycle tick"')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line split across two chunks
    }
  }
  return out;
}

/** Waits until the lifecycle has run on a block at or after chain time t. */
async function waitTick(t, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (ticks().some((l) => BigInt(l.chainTime) >= BigInt(t))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function warpAndTick(t) {
  await warpTo(t);
  assert.ok(await waitTick(t), `no lifecycle tick reached ${t}`);
}

let listener;
const openedIds = (c) => events(c, "batch.opened").map((f) => f.frame.data.batchId);
const closedIds = (c) => events(c, "batch.collect_closed").map((f) => f.frame.data.batchId);

describe("F9 batch lifecycle", () => {
  test("F9-0 start the api with lifecycle logging", async () => {
    await restartApi(g, {NOKTURN_API_LOG_LEVEL: "debug"});
    listener = await connect(g.api, {topics: LIVE_TOPICS});
    assert.ok(await waitTick(await chainNow()), "the lifecycle never ticked");
  });

  test("F9-1 five batches in a row", async () => {
    const start = listener.frames.length;
    const seen = [];
    await manualMining(async () => {
      for (let i = 0; i < 5; i += 1) {
        const batch = await currentBatch(g.api);
        await warpAndTick(BigInt(batch.collectEndsAt) + 1n);
        const now = await currentBatch(g.api);
        seen.push({closed: batch.batchId, current: now.batchId});
      }
    });
    // The interval miner runs until manualMining stops it, so the batch that
    // turned over just before is heard here too. Only the five this test walked
    // through are compared.
    const first = BigInt(seen[0].closed);
    const frames = listener.frames
      .slice(start)
      .map((f) => f.frame)
      .filter((f) => (f.type === "batch.opened" || f.type === "batch.collect_closed") && BigInt(f.data.batchId) >= first);
    const expected = seen.flatMap((s) => [`batch.collect_closed ${s.closed}`, `batch.opened ${s.current}`]);
    const got = frames.map((f) => `${f.type} ${f.data.batchId}`);
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    g.record("F9-1", {
      outcome: ok ? "pass" : "finding",
      summary: `${got.length} event dari ${expected.length} yang diharapkan, urutan ${ok ? "sesuai" : "berbeda"}, batchId sama dengan GET current`,
      evidence: {got, expected},
    });
    assert.ok(ok, JSON.stringify({got, expected}));
  });

  test("F9-2 collect_closed lands within two blocks of collectEnd", async () => {
    // Left to the interval miner, so the close is found by the lifecycle on its
    // own rather than on a block the test mined for it.
    const batch = await currentBatch(g.api);
    const closed = await waitFor(listener, (f) => f.frame.type === "batch.collect_closed" && f.frame.data.batchId === batch.batchId, 120_000);
    const feed = await get(g.api, `/v1/batches/${batch.batchId}/intents`);
    const late = closed ? closed.frame.at - batch.collectEndsAt : null;
    const ok = closed !== null && late >= 1 && late <= 2 && feed.body?.frozen === true;
    g.record("F9-2", {
      outcome: ok ? "pass" : "finding",
      summary: `collectEnd ${batch.collectEndsAt}, collect_closed pada ${closed?.frame.at ?? "-"} (${late} dtk sesudahnya), feed frozen ${feed.body?.frozen}`,
    });
    assert.ok(ok);
  });

  test("F9-3 a warp across ten batches", async () => {
    const {batch, duration, start, after} = await manualMining(async () => {
      const batch = await currentBatch(g.api);
      const duration = batch.collectEndsAt - batch.collectStartsAt;
      const start = listener.frames.length;
      await warpAndTick(BigInt(batch.collectEndsAt + 10 * duration) + 1n);
      await new Promise((r) => setTimeout(r, 3000));
      return {batch, duration, start, after: await currentBatch(g.api)};
    });
    const frames = listener.frames.slice(start).map((f) => f.frame);
    const opened = frames.filter((f) => f.type === "batch.opened").map((f) => f.data.batchId);
    const closed = frames.filter((f) => f.type === "batch.collect_closed").map((f) => f.data.batchId);
    const alive = (await get(g.api, "/")).status === 200;
    const ok = alive && JSON.stringify(closed) === JSON.stringify([batch.batchId]) && JSON.stringify(opened) === JSON.stringify([after.batchId]);
    g.record("F9-3", {
      outcome: ok ? "pass" : "finding",
      summary: `lompat ${10 * duration} dtk, ditutup ${closed.join(",") || "-"}, dibuka ${opened.join(",") || "-"}, current ${after.batchId}, proses hidup ${alive}`,
    });
    assert.ok(ok, JSON.stringify({opened, closed}));
  });

  test("F9-4 chain time going backwards", async () => {
    // Left on the interval miner on purpose. Under manual mining nothing would
    // ever climb past the old height again, and the lifecycle would stay deaf.
    const id = await snapshot();
    const before = await currentBatch(g.api);
    for (let i = 0; i < 3; i += 1) {
      const b = await currentBatch(g.api);
      await warpAndTick(BigInt(Math.max(b.collectEndsAt + 1, Number(await chainNow()) + 1)));
    }
    const lastBefore = ticks().at(-1);
    const start = listener.frames.length;
    const revertedAt = performance.now();
    await revert(id);

    // N7. watchBlockNumber drops every block number at or below the highest it
    // has seen, so after a revert the lifecycle hears nothing until the chain is
    // taller again. Measured here rather than worked around.
    let warned = false;
    const deadline = performance.now() + 120_000;
    while (performance.now() < deadline && !warned) {
      warned = g.api.logs.some((l) => l.includes("chain time went backwards") && l.includes(`"from":"${lastBefore.chainTime}"`));
      if (!warned) await new Promise((r) => setTimeout(r, 200));
    }
    const delayMs = Math.round(performance.now() - revertedAt);
    await new Promise((r) => setTimeout(r, 2000));
    const now = await currentBatch(g.api);
    const frames = listener.frames.slice(start).map((f) => f.frame);
    const opened = frames.filter((f) => f.type === "batch.opened").map((f) => f.data.batchId);
    const closed = frames.filter((f) => f.type === "batch.collect_closed").map((f) => f.data.batchId);
    // The interval miner keeps going while the lifecycle is deaf, so the batch
    // reopened is the one at revert time or, across a boundary, the next.
    const ok = warned && opened.length >= 1 && [before.batchId, now.batchId].includes(opened[0]) && opened.length <= 2 && closed.length <= 1;
    g.record("F9-4", {
      outcome: ok ? "pass" : "finding",
      suspect: "N7",
      summary: `revert dari blok ${lastBefore?.block}, peringatan tercatat ${warned} setelah ${delayMs} ms, dibuka ulang ${opened.join(",")}, ditutup ${closed.join(",") || "-"}, current ${now.batchId}`,
      evidence: {delayMs, before: before.batchId},
    });
    assert.ok(ok, JSON.stringify({warned, opened, closed, before: before.batchId}));
  });

  test("F9-8 a token entering and leaving PROTECTIVE", async () => {
    const token = ctx.tokens.find((t) => t.symbol === "NVDA").token;
    const governor = await ctx.client.readContract({address: ctx.deployment.sessions, abi: abis.session, functionName: "governor"});
    const call = (functionName, args) => sendAs({from: governor, to: ctx.deployment.sessions, data: encodeFunctionData({abi: abis.session, functionName, args})});
    const result = await withSnapshot(async () => {
      const start = listener.frames.length;
      const r1 = await call("setProtective", [token, keccak256(toHex("torture F9-8"))]);
      assert.ok(await waitTick((await chainNow()) + 1n));
      let exits = 0;
      for (let i = 0; i < 5; i += 1) {
        const session = await ctx.client.readContract({address: ctx.deployment.sessions, abi: abis.session, functionName: "tokenSession", args: [token]});
        if (Number(session) !== 8) break;
        await call("reportHealthy", [token]);
        exits += 1;
      }
      assert.ok(await waitTick((await chainNow()) + 1n));
      // The tick's log line and its frame travel on different pipes, so the
      // frame is waited for rather than assumed to be there already.
      const isMine = (f) => f.frame.type === "token.protective" && f.frame.data.token.toLowerCase() === token.toLowerCase() && listener.frames.indexOf(f) >= start;
      await waitFor(listener, (f) => isMine(f) && f.frame.data.cleared === true, 10_000);
      const mine = listener.frames.filter(isMine);
      return {cleared: mine.map((f) => f.frame.data.cleared), reports: exits, block: r1.blockNumber};
    });
    const ok = JSON.stringify(result.cleared) === "[false,true]";
    g.record("F9-8", {
      outcome: ok ? "pass" : "finding",
      summary: `setProtective lalu ${result.reports} kali reportHealthy sebagai governor dalam snapshot, event cleared ${JSON.stringify(result.cleared)}`,
    });
    assert.ok(ok, JSON.stringify(result));
  });

  test("F9-6 thirty percent of rpc calls failing for sixty blocks", {timeout: 5 * 60_000}, async () => {
    const pid = g.api.pid;
    const startFrames = listener.frames.length;
    const from = await chainNow();
    g.proxy.setRules([{mode: "error", pct: 30}]);
    while ((await chainNow()) < from + 60n) await new Promise((r) => setTimeout(r, 1000));
    g.proxy.pass();
    const settleAt = (await chainNow()) + 15n;
    while ((await chainNow()) < settleAt) await new Promise((r) => setTimeout(r, 1000));

    // A batch opened before the chaos began and closing inside it is exactly the
    // case this is about, so every batch the listener ever saw open counts when
    // its collectEnd falls inside the window.
    const frames = listener.frames.slice(startFrames).map((f) => f.frame);
    const opened = events(listener, "batch.opened").map((f) => f.frame.data);
    const closed = frames.filter((f) => f.type === "batch.collect_closed").map((f) => f.data.batchId);
    const now = Number(await chainNow());
    const due = [...new Set(opened.filter((b) => b.collectEndsAt >= Number(from) && b.collectEndsAt < now - 5).map((b) => b.batchId))];
    const wrong = due.filter((id) => closed.filter((c) => c === id).length !== 1);
    const dupes = closed.filter((id, i) => closed.indexOf(id) !== i);
    const alive = g.api.proc.exitCode === null && g.api.pid === pid && (await get(g.api, "/")).status === 200;
    const failures = g.api.logs.filter((l) => l.includes("lifecycle tick failed"));
    const ticked = ticks().filter((l) => BigInt(l.chainTime) >= from).length;
    const ok = alive && wrong.length === 0 && dupes.length === 0 && due.length > 0;
    g.record("F9-6", {
      outcome: ok ? "pass" : "finding",
      summary: `${g.proxy.stats.errored} panggilan digagalkan, ${ticked} tick berhasil dan ${failures.length} gagal sejak kacau, ${due.length} batch jatuh tempo, ${wrong.length} tidak tepat sekali ditutup, ganda ${dupes.length}, proses hidup ${alive}`,
      evidence: {wrong, dupes, openedInWindow: frames.filter((f) => f.type === "batch.opened").length, firstFailure: failures[0]?.slice(0, 300)},
    });
    assert.ok(ok);
  });

  test("F9-7 the node hangs for thirty seconds", {timeout: 5 * 60_000}, async () => {
    const pid = g.api.pid;
    const before = ticks().length;
    g.proxy.setRules([{mode: "hang"}]);
    await new Promise((r) => setTimeout(r, 30_000));
    g.proxy.pass();
    g.proxy.releaseHung();
    const resumeFrom = await chainNow();
    const resumed = await waitTick(resumeFrom + 2n, 60_000);
    const all = ticks();
    const maxConcurrent = Math.max(...all.map((l) => l.concurrent ?? 0));
    const ok = resumed && maxConcurrent === 1 && g.api.pid === pid && g.api.proc.exitCode === null;
    g.record("F9-7", {
      outcome: ok ? "pass" : "finding",
      summary: `tick paling banyak berjalan bersamaan ${maxConcurrent}, ${all.length - before} tick sejak hang, pulih tanpa restart ${resumed}`,
    });
    assert.ok(ok);
  });

  test("F9-9 a stale feed on a weekday is announced per transition, not per block", {timeout: 5 * 60_000}, async () => {
    // Pattern C3-5. The feeds stopped at the pinned block. On the weekend the
    // oracle prices from the TWAP and reports healthy, and the moment the weekend
    // ends it falls back to the feed, which is by then older than any staleness
    // limit. So the transition sits at the start of CLOSED_OVERNIGHT, and this
    // runs before F9-5 walks the calendar past it. The expected count is read
    // from refPrice on every block the lifecycle sees, which makes it the number
    // of real transitions.
    const health = async () => {
      const out = {};
      for (const t of ctx.tokens) {
        try {
          out[t.token.toLowerCase()] = (await ctx.client.readContract({address: ctx.deployment.oracle, abi: abis.oracle, functionName: "refPrice", args: [t.token]}))[2];
        } catch {
          // no source, never announced
        }
      }
      return out;
    };
    const {expected, announced, blocks} = await manualMining(async () => {
      const weekdayStart = await findSessionStart(SESSION.CLOSED_OVERNIGHT, await chainNow());
      await warpAndTick(weekdayStart - 120n);
      const start = listener.frames.length;
      const expected = {};
      let last = await health();
      let blocks = 0;
      const points = [weekdayStart - 60n, weekdayStart + 60n, ...Array.from({length: 10}, (_, i) => weekdayStart + 61n + BigInt(i))];
      for (const t of points) {
        await warpAndTick(t);
        blocks += 1;
        const now = await health();
        for (const [token, ok] of Object.entries(now)) {
          if (last[token] === true && ok === false) expected[token] = (expected[token] ?? 0) + 1;
        }
        last = now;
      }
      const announced = listener.frames.slice(start).map((f) => f.frame).filter((f) => f.type === "oracle.unhealthy").map((f) => f.data);
      return {expected, announced, blocks};
    });
    const got = {};
    for (const a of announced) got[a.token.toLowerCase()] = (got[a.token.toLowerCase()] ?? 0) + 1;
    const ok = Object.keys(expected).length > 0 && JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(expected).sort()) && announced.every((a) => a.reason === "stale");
    g.record("F9-9", {
      outcome: ok ? "pass" : "finding",
      summary: `${blocks} blok melintasi akhir pekan ke CLOSED_OVERNIGHT, transisi sehat ke tidak sehat ${JSON.stringify(Object.values(expected))}, event ${JSON.stringify(Object.values(got))}, alasan ${[...new Set(announced.map((a) => a.reason))].join(",") || "-"}`,
      evidence: {detail: announced[0]?.detail},
    });
    assert.ok(ok, JSON.stringify({expected, got}));
  });

  test("F9-5 across a session change and both auction phases", {timeout: 5 * 60_000}, async () => {
    await manualMining(async () => {
      const aoStart = await findSessionStart(SESSION.AUCTION_OPEN, await chainNow());
      const openStart = await nextTransition(aoStart);
      const acStart = await findSessionStart(SESSION.AUCTION_CLOSE, openStart);
      const postStart = await nextTransition(acStart);

      await warpAndTick(aoStart - 120n);
      const start = listener.frames.length;
      const steps = [
        ["AUCTION_OPEN mulai", aoStart + 1n],
        ["tengah AUCTION_OPEN", aoStart + (openStart - aoStart) / 2n],
        ["OPEN mulai", openStart + 1n],
        ["OPEN berjalan", openStart + 120n],
        ["AUCTION_CLOSE mulai", acStart + 1n],
        ["tengah AUCTION_CLOSE", acStart + (postStart - acStart) / 2n],
        ["POST_MARKET mulai", postStart + 1n],
        ["POST_MARKET berjalan", postStart + 120n],
      ];
      const timeline = [];
      for (const [label, t] of steps) {
        const mark = listener.frames.length;
        await warpAndTick(t);
        await new Promise((r) => setTimeout(r, 300));
        const got = listener.frames.slice(mark).map((f) => f.frame);
        timeline.push({
          label,
          t: String(t),
          changed: got.filter((f) => f.type === "session.changed").map((f) => f.data.sessionName),
          opened: got.filter((f) => f.type === "batch.opened").map((f) => ({id: f.data.batchId, session: f.data.sessionName})),
          current: (await currentBatch(g.api)).batchId,
        });
      }
      const frames = listener.frames.slice(start).map((f) => f.frame);
      const changes = frames.filter((f) => f.type === "session.changed").map((f) => f.data.sessionName);
      const openedInAuction = timeline.filter((s) => s.label.includes("AUCTION")).flatMap((s) => s.opened);
      const firstOpen = timeline.find((s) => s.label === "OPEN mulai");
      const firstPost = timeline.find((s) => s.label === "POST_MARKET mulai");
      const ok =
        JSON.stringify(changes) === JSON.stringify(["AUCTION_OPEN", "OPEN", "AUCTION_CLOSE", "POST_MARKET"]) &&
        openedInAuction.length === 0 &&
        firstOpen.opened.length === 1 &&
        firstOpen.opened[0].id === firstOpen.current &&
        firstPost.opened.length === 1 &&
        firstPost.opened[0].id === firstPost.current;
      g.record("F9-5", {
        outcome: ok ? "pass" : "finding",
        summary: `session.changed ${changes.join(" > ")}, batch.opened selama lelang ${openedInAuction.length}, batch pertama OPEN ${firstOpen.opened[0]?.id ?? "-"}, batch pertama POST_MARKET ${firstPost.opened[0]?.id ?? "-"}`,
        evidence: {timeline},
      });
      assert.ok(ok, JSON.stringify(timeline));
    });
  });

  test("F9-10 fifty batches in a row", {timeout: 10 * 60_000}, async () => {
    const from = await chainNow();
    await manualMining(async () => {
      for (let i = 0; i < 50; i += 1) {
        const b = await currentBatch(g.api);
        const next = b.batchId === null ? BigInt(b.chainTime) + 30n : BigInt(b.collectEndsAt) + 1n;
        await warpAndTick(next);
      }
    });
    const lines = ticks().filter((l) => BigInt(l.chainTime) > from);
    const maxTracked = Math.max(...lines.map((l) => l.tracked));
    const reads = lines.map((l) => l.reads).sort((a, b) => a - b);
    const ok = maxTracked <= 8;
    g.record("F9-10", {
      outcome: ok ? "pass" : "finding",
      summary: `${lines.length} tick, batch dilacak paling banyak ${maxTracked}, pembacaan per tick median ${reads[Math.floor(reads.length / 2)]} maksimum ${reads.at(-1)}`,
      evidence: {reads: {min: reads[0], median: reads[Math.floor(reads.length / 2)], max: reads.at(-1)}},
    });
    await closeAll([listener]);
    assert.ok(ok);
  });
});
