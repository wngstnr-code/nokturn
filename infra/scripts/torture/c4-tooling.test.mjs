// Group C4. The signing script and the Postman collection, commit 7d7ac4d.

import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {readFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {describe, test} from "node:test";
import {encodeFunctionData, maxUint256, parseAbi} from "viem";
import {REPO_ROOT} from "./lib/api.mjs";
import {EVIDENCE_DIR} from "./lib/evidence.mjs";
import {FORK_RPC, chainNow, sendAs, warpTo, withSnapshot} from "./lib/fork.mjs";
import {useGroup} from "./lib/harness.mjs";
import {USDG, abis, ctx, users} from "./lib/sign.mjs";

const g = useGroup(import.meta.url);

const SIGN_INTENT = join(REPO_ROOT, "infra", "scripts", "sign-intent.mjs");
const POSTMAN_API = join(REPO_ROOT, "infra", "scripts", "postman-api.mjs");
const COLLECTION = "postman/nokturn-api.postman_collection.json";
const erc20 = parseAbi(["function allowance(address,address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

const allowanceOf = (owner) => ctx.client.readContract({address: USDG().address, abi: erc20, functionName: "allowance", args: [owner, ctx.permit2]});
const bitmapOf = (owner, word = 0n) => ctx.client.readContract({address: ctx.permit2, abi: abis.permit2, functionName: "nonceBitmap", args: [owner, word]});

function run(file, args = [], env = {}, timeout = 120_000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], {cwd: join(REPO_ROOT, "infra"), env: {...process.env, NOKTURN_FORK_RPC: FORK_RPC, ...env}, timeout}, (error, stdout, stderr) => {
      resolve({code: error?.code ?? 0, out: `${stdout}${stderr}`});
    });
  });
}

function runShell(command, timeout = 300_000) {
  return new Promise((resolve) => {
    execFile("bash", ["-lc", command], {cwd: REPO_ROOT, timeout, env: process.env}, (error, stdout, stderr) => {
      resolve({code: error?.code ?? 0, out: `${stdout}${stderr}`});
    });
  });
}

/**
 * Starts a sign-intent case and kills it with SIGKILL the moment it has changed
 * fork state, which is the instant a finally block would have had to run.
 */
async function killMidway(caseName, changed) {
  const child = spawn(process.execPath, [SIGN_INTENT, "--case", caseName], {
    cwd: join(REPO_ROOT, "infra"),
    env: {...process.env, NOKTURN_FORK_RPC: FORK_RPC, NOKTURN_API_URL: g.api.url},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let killed = false;
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline && child.exitCode === null) {
    if (/state changed/.test(out) || (await changed())) {
      child.kill("SIGKILL");
      killed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  await exited;
  return {killed, out};
}

const newmanSummary = (out) => {
  const assertions = /assertions\s*│\s*(\d+)\s*│\s*(\d+)/.exec(out);
  const requests = /requests\s*│\s*(\d+)\s*│\s*(\d+)/.exec(out);
  return assertions ? {requests: Number(requests?.[1]), assertions: Number(assertions[1]), failed: Number(assertions[2])} : null;
};

/**
 * Runs a collection file through newman with its JSON reporter, so a failure
 * comes back with the request and assertion it belongs to rather than as a
 * count. A count alone cannot say which case went stale.
 */
async function runNewman(collection, tag) {
  const report = join(EVIDENCE_DIR, `newman-${tag}.json`);
  rmSync(report, {force: true});
  const res = await runShell(
    `cd infra && pnpm dlx newman run ${collection} --reporters cli,json --reporter-cli-no-banner --reporter-json-export "${report.replace(/\\/g, "/")}"`,
  );
  let run = null;
  try {
    run = JSON.parse(readFileSync(report, "utf8")).run;
  } catch {
    return {code: res.code, ran: false, tail: res.out.split("\n").filter(Boolean).slice(-3).join(" | ")};
  }
  return {
    code: res.code,
    ran: true,
    requests: run.stats.requests.total,
    assertions: run.stats.assertions.total,
    failed: run.stats.assertions.failed,
    failures: run.failures.map((f) => `${f.source?.name ?? "?"} :: ${f.error?.test ?? f.error?.message ?? "?"}`),
  };
}

describe("C4 signing script and Postman", () => {
  test("C4-1 SIGKILL during --case no-approve", async () => {
    await withSnapshot(async () => {
      const before = await Promise.all(users.map((u) => allowanceOf(u.address)));
      const {killed, out} = await killMidway("no-approve", async () => (await Promise.all(users.map((u) => allowanceOf(u.address)))).some((a) => a !== maxUint256));
      const after = await Promise.all(users.map((u) => allowanceOf(u.address)));
      const leftBehind = users.flatMap((u, i) => (after[i] !== before[i] ? [`${u.address} allowance ${after[i]}`] : []));
      g.record("C4-1", {
        outcome: leftBehind.length === 0 ? "pass" : "finding",
        suspect: "D16",
        summary: killed
          ? leftBehind.length
            ? `dibunuh setelah approve(0), allowance tertinggal di ${leftBehind.length} akun demo`
            : "dibunuh di tengah, tidak ada allowance akun demo yang berubah"
          : "skrip selesai sebelum sempat dibunuh",
        evidence: {leftBehind, tail: out.split("\n").slice(-4).join(" | ")},
      });
      assert.ok(killed, "never caught the script mid way");
      assert.deepEqual(leftBehind, []);
    });
  });

  test("C4-2 SIGKILL during --case nonce-used", async () => {
    await withSnapshot(async () => {
      const before = await Promise.all(users.map((u) => bitmapOf(u.address)));
      const {killed, out} = await killMidway("nonce-used", async () => (await Promise.all(users.map((u) => bitmapOf(u.address)))).some((b, i) => b !== before[i]));
      const after = await Promise.all(users.map((u) => bitmapOf(u.address)));
      const burned = users.filter((_, i) => after[i] !== before[i]).map((u) => u.address);
      g.record("C4-2", {
        outcome: burned.length === 0 ? "pass" : "finding",
        suspect: "D16",
        summary: killed ? (burned.length ? `nonce akun demo terbakar permanen di ${burned.join(", ")}` : "dibunuh di tengah, tidak ada nonce akun demo yang terbakar") : "skrip selesai sebelum sempat dibunuh",
        evidence: {tail: out.split("\n").slice(-4).join(" | ")},
      });
      assert.ok(killed, "never caught the script mid way");
      assert.deepEqual(burned, []);
    });
  });

  test("C4-3 sign-intent twice in a row", {todo: "KEPUTUSAN D5"}, async () => {
    const first = await run(SIGN_INTENT, [], {NOKTURN_API_URL: g.api.url});
    const second = await run(SIGN_INTENT, [], {NOKTURN_API_URL: g.api.url});
    const ok = first.code === 0 && second.code === 0;
    g.record("C4-3", {
      outcome: ok ? "pass" : "finding",
      suspect: "D5",
      summary: `pertama keluar ${first.code}, kedua keluar ${second.code}`,
      evidence: {second: second.out.split("\n").find((l) => /FAIL|submitted/.test(l))},
    });
    assert.ok(ok, second.out);
  });

  test("C4-4 the Postman collection after two hours of chain time", {timeout: 15 * 60_000}, async () => {
    const generated = await run(POSTMAN_API, [], {NOKTURN_API_URL: g.api.url});
    assert.equal(generated.code, 0, generated.out);
    const viaMake = await runShell("make -C infra postman-api");
    const f = await runNewman(COLLECTION, "c4-4-fresh");
    await warpTo((await chainNow()) + 7200n);
    const a = await runNewman(COLLECTION, "c4-4-aged");
    const makeSummary = newmanSummary(viaMake.out);
    g.record("C4-4", {
      outcome: a.ran && f.ran && a.failed === f.failed ? "pass" : "finding",
      suspect: "D17",
      summary: `koleksi baru ${f.failed ?? "?"} gagal dari ${f.assertions ?? "?"} assertion, setelah maju 2 jam ${a.failed ?? "?"} gagal`,
      evidence: {freshFailures: f.failures, agedFailures: a.failures},
    });
    // Newman running is not the bar. make exits 1 when an assertion fails,
    // and that once went down here as a pass.
    const literalNewline = readFileSync(join(REPO_ROOT, "infra", "Makefile"), "utf8").includes(" \\n\t");
    const makeClean = viaMake.code === 0 && makeSummary?.failed === 0;
    g.record("C4-4m", {
      outcome: makeClean && !literalNewline ? "pass" : "finding",
      summary: literalNewline
        ? "resep newman di infra/Makefile memuat \\n harfiah, bash mengubahnya jadi argumen n yang kebetulan diabaikan newman"
        : `make postman-api keluar dengan kode ${viaMake.code}, ${makeSummary ? `${makeSummary.failed} assertion gagal` : "newman tidak berjalan"}`,
      evidence: {tail: viaMake.out.split("\n").filter(Boolean).slice(-3).join(" | ")},
    });
    assert.ok(f.ran, `newman did not run: ${f.tail}`);
    assert.equal(a.failed, f.failed, `collection fails after chain time moves: ${a.failures.join("; ")}`);
    assert.ok(makeClean, `make postman-api exited ${viaMake.code} with ${makeSummary?.failed} failed`);
  });

  test("C4-5 sign-intent against an unfunded user and a dead API", async () => {
    const unfunded = await withSnapshot(async () => {
      const u = users[0];
      const bal = await ctx.client.readContract({address: USDG().address, abi: erc20, functionName: "balanceOf", args: [u.address]});
      await sendAs({from: u.address, to: USDG().address, data: encodeFunctionData({abi: erc20, functionName: "transfer", args: [users[1].address, bal]})});
      return run(SIGN_INTENT, [], {NOKTURN_API_URL: g.api.url});
    });
    const deadApi = await run(SIGN_INTENT, [], {NOKTURN_API_URL: "http://127.0.0.1:3199"});
    const stack = (o) => /\n\s+at .+:\d+:\d+/.test(o);
    const r = {
      unfunded: {mentionsFund: /make fund/.test(unfunded.out), stack: stack(unfunded.out), line: unfunded.out.split("\n").find((l) => /FAIL|Error/.test(l))},
      deadApi: {mentionsApi: /make api/.test(deadApi.out), stack: stack(deadApi.out), line: deadApi.out.split("\n").find((l) => /Error|fetch/.test(l))},
    };
    const ok = r.unfunded.mentionsFund && !r.unfunded.stack && r.deadApi.mentionsApi && !r.deadApi.stack;
    g.record("C4-5", {suspect: "N5", 
      outcome: ok ? "pass" : "finding",
      summary: `tanpa dana: menyebut make fund ${r.unfunded.mentionsFund}, stack trace ${r.unfunded.stack}. API mati: menyebut make api ${r.deadApi.mentionsApi}, stack trace ${r.deadApi.stack}`,
      evidence: r,
    });
    assert.ok(ok);
  });
});
