// Group R. Reliability against the RPC. The API reaches anvil only through
// rpc-chaos-proxy.mjs, and the last two scenarios restart anvil underneath it.
//
// No snapshot for this group, because R-6 and R-7 kill the node that owns it.
// Nothing before them writes to the chain, and R-7 ends by restoring the
// canonical deployment.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, test} from "node:test";
import {REPO_ROOT, get, percentile, rssOf, submit} from "./lib/api.mjs";
import {mb} from "./lib/evidence.mjs";
import {chainNow, killFork, restartFork} from "./lib/fork.mjs";
import {nonceSource, pool, useGroup} from "./lib/harness.mjs";
import {accountsFile, digestOf, makeIntent, signRaw, users} from "./lib/sign.mjs";

const g = useGroup(import.meta.url, {proxy: true, snap: false});
const nextNonce = nonceSource(4);
const FORK_LOG = join(REPO_ROOT, "infra", ".torture", "fork-restart.log");
const deploymentFile = () => JSON.parse(readFileSync(join(REPO_ROOT, "infra", "fork-deployment.json"), "utf8"));

async function freshSigned(i = 0) {
  const u = users[i % users.length];
  return signRaw(makeIntent({owner: u.address, nonce: nextNonce(), now: await chainNow()}), u);
}

/** Sends n valid intents with the given concurrency and classifies what came back. */
async function burst(n, concurrency) {
  const signed = [];
  for (let i = 0; i < n; i += 1) signed.push(await freshSigned(i));
  const answers = await pool(signed, concurrency, (s) => submit(g.api, s, {timeoutMs: 120_000}));
  const classes = {};
  for (const a of answers) {
    const key = a.status === 0 ? `client ${a.error}` : `${a.status} ${a.body?.code ?? ""}`.trim();
    classes[key] = (classes[key] ?? 0) + 1;
  }
  return {answers, classes, latencies: answers.map((a) => a.ms)};
}

describe("R reliability against the RPC", () => {
  test("R-1 200 ms on every call, the baseline", async () => {
    g.proxy.setRules([{mode: "latency", ms: 200}]);
    try {
      const {latencies, classes} = await burst(50, 1);
      g.record("R-1", {
        outcome: "measure",
        summary: `p50 ${percentile(latencies, 50)} ms, p99 ${percentile(latencies, 99)} ms untuk POST /v1/intents dengan latensi RPC 200 ms`,
        evidence: {classes},
      });
    } finally {
      g.proxy.pass();
    }
  });

  for (const [id, mode] of [["R-2", "drop"], ["R-3", "error"]]) {
    test(`${id} ${mode} 10 percent of RPC calls`, {timeout: 20 * 60_000}, async () => {
      g.proxy.setRules([{mode, pct: 10}]);
      g.proxy.resetStats();
      let result;
      try {
        result = await burst(1000, 16);
      } finally {
        g.proxy.pass();
      }
      const fake4xx = Object.entries(result.classes).filter(([k]) => /^4\d\d/.test(k));
      const ok = fake4xx.length === 0;
      g.record(id, {
        outcome: ok ? "pass" : "finding",
        summary: `${Object.entries(result.classes).map(([k, v]) => `${v}x ${k}`).join(", ")}. Proxy ${mode === "drop" ? "memutus" : "menggagalkan"} ${mode === "drop" ? g.proxy.stats.dropped : g.proxy.stats.errored} dari ${g.proxy.stats.requests} panggilan`,
        evidence: {p99: percentile(result.latencies, 99)},
      });
      assert.deepEqual(fake4xx, [], "an RPC failure surfaced as a client error");
    });
  }

  test("R-4 getCode never answers", {timeout: 10 * 60_000, todo: "D9"}, async () => {
    g.proxy.setRules([{mode: "hang", methods: ["eth_getCode"]}]);
    g.proxy.resetStats();
    const latencies = [];
    const classes = {};
    let inFlight = 0;
    let peakInFlight = 0;
    const seconds = Number(process.env.NOKTURN_TORTURE_HANG_SECONDS ?? 60);
    const until = performance.now() + seconds * 1000;
    const rssBefore = rssOf(g.api.pid);
    const client = async (i) => {
      while (performance.now() < until) {
        const s = await freshSigned(i);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        const res = await submit(g.api, s, {timeoutMs: 180_000});
        inFlight -= 1;
        latencies.push(res.ms);
        const key = res.status === 0 ? `client ${res.error}` : `${res.status} ${res.body?.code ?? ""}`.trim();
        classes[key] = (classes[key] ?? 0) + 1;
      }
    };
    await Promise.all(Array.from({length: 50}, (_, i) => client(i)));
    const worst = Math.max(...latencies);
    const ok = worst <= 30_000;
    g.record("R-4", {
      outcome: ok ? "pass" : "finding",
      suspect: "D9",
      summary: `50 klien selama ${seconds} dtk. ${latencies.length} request selesai, terlama ${worst} ms, p50 ${percentile(latencies, 50)} ms. ${g.proxy.stats.hung} panggilan getCode menggantung di proxy`,
      evidence: {classes, peakInFlight, rss: `${mb(rssBefore)} MB lalu ${mb(rssOf(g.api.pid))} MB`},
    });
    assert.ok(ok, `a request was held ${worst} ms`);
  });

  test("R-5 recovery once the node answers again", async () => {
    g.proxy.pass();
    g.proxy.releaseHung();
    const res = await submit(g.api, await freshSigned());
    const ok = res.status === 200 && res.ms < 2000;
    g.record("R-5", {outcome: ok ? "pass" : "finding", summary: `request pertama setelah pulih ${res.status} dalam ${res.ms} ms, tanpa restart API`});
    assert.ok(ok, res.text);
  });

  test("R-6 anvil killed and restarted on the same port and block", {timeout: 30 * 60_000}, async () => {
    const before = deploymentFile();
    const lastBatchBefore = (await get(g.api, "/v1/batches/current")).body?.batchId;
    const signedBeforeKill = await freshSigned();
    await killFork();
    const whileDown = await submit(g.api, signedBeforeKill, {timeoutMs: 120_000});
    await restartFork({repoRoot: REPO_ROOT, logFile: FORK_LOG});
    const after = deploymentFile();
    const res = await submit(g.api, await freshSigned());
    const current = (await get(g.api, "/v1/batches/current")).body;
    const ok = res.status === 200 && after.settlement === before.settlement;
    g.record("R-6", {
      outcome: ok ? "pass" : "finding",
      summary: `saat mati ${whileDown.status} ${whileDown.body?.code ?? whileDown.error}, setelah hidup ${res.status} tanpa restart API. Alamat Settlement sama ${after.settlement === before.settlement}`,
      evidence: {
        batchBeforeKill: lastBatchBefore,
        batchAfterRestart: current?.batchId,
        note: "fork baru mulai lagi dari waktu blok yang dipin, jadi waktu chain mundur. Batch yang sudah dikenal mempool dari sebelum restart bisa muncul lagi dengan batchId yang sama",
        intentCountAfter: current?.intentCount,
      },
    });
    assert.ok(ok, res.text);
  });

  test("R-7 a redeploy to new addresses under a running API", {timeout: 45 * 60_000, todo: "D12"}, async () => {
    const canonical = deploymentFile();
    let result;
    try {
      await killFork();
      await restartFork({repoRoot: REPO_ROOT, logFile: FORK_LOG, bumpNonce: true, deployer: accountsFile.deployer});
      const moved = deploymentFile();
      assert.notEqual(moved.settlement, canonical.settlement, "the nonce bump did not move the deployment");
      const u = users[0];
      const intent = makeIntent({owner: u.address, nonce: nextNonce(), now: await chainNow()});
      const signature = await u.sign({hash: await digestOf(intent, {spender: moved.settlement})});
      const res = await submit(g.api, {intent, signature});
      result = {moved: moved.settlement, status: res.status, code: res.body?.code, message: res.body?.message};
    } finally {
      await killFork();
      await restartFork({repoRoot: REPO_ROOT, logFile: FORK_LOG});
    }
    const restored = deploymentFile().settlement === canonical.settlement;
    const ok = result.status === 503 && /deploy/i.test(result.message ?? "");
    g.record("R-7", {
      outcome: ok ? "pass" : "finding",
      suspect: "D12",
      summary: `Settlement pindah ke ${result.moved}, API lama menjawab tanda tangan sah untuk Settlement baru dengan ${result.status} ${result.code}. Deployment kanonik dipulihkan ${restored}`,
      evidence: {message: result.message},
    });
    assert.ok(restored, "canonical deployment not restored, rerun make fork deploy fund");
    assert.ok(ok, JSON.stringify(result));
  });
});
