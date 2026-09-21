// Group C0. Shared validation and the escape hatch, commit 6989551.

import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {decodeEventLog, toFunctionSelector} from "viem";
import {post, submit} from "./lib/api.mjs";
import {chainNow, sendAs} from "./lib/fork.mjs";
import {nonceSource, restartApi, useGroup} from "./lib/harness.mjs";
import {abis, ctx, makeIntent, signRaw, users} from "./lib/sign.mjs";

const g = useGroup(import.meta.url, {proxy: true});
const nextNonce = nonceSource(0);

const FIELDS = [
  "owner",
  "receiver",
  "sellToken",
  "buyToken",
  "sellAmount",
  "minBuyAmount",
  "validAfter",
  "validUntil",
  "flags",
  "kind",
  "maxDevFromRefBps",
  "allowedSessions",
  "batchSpan",
  "nonce",
];
const ADDRESS_FIELDS = FIELDS.slice(0, 4);
const NUMERIC_FIELDS = FIELDS.slice(4);

/** The Solidity width of each numeric field, IntentLib and intent.ts intentTuple. */
const WIDTH = {
  sellAmount: 256,
  minBuyAmount: 256,
  validAfter: 32,
  validUntil: 32,
  flags: 8,
  kind: 8,
  maxDevFromRefBps: 16,
  allowedSessions: 8,
  batchSpan: 16,
  nonce: 256,
};

async function validSigned() {
  return signRaw(makeIntent({owner: users[0].address, nonce: nextNonce(), now: await chainNow()}), users[0]);
}

describe("C0 shared validation and escape hatch", () => {
  test("C0-1 both routes reject malformed payloads identically", async () => {
    const base = await validSigned();
    const variants = [];
    for (const f of FIELDS) {
      const intent = {...base.intent};
      delete intent[f];
      variants.push({name: `missing ${f}`, intent});
    }
    for (const f of ADDRESS_FIELDS) variants.push({name: `bad address ${f}`, intent: {...base.intent, [f]: "0x1234"}});
    for (const f of NUMERIC_FIELDS) variants.push({name: `non decimal ${f}`, intent: {...base.intent, [f]: "abc"}});
    variants.push({name: "intent is an array", intent: []});
    variants.push({name: "intent is a string", intent: "intent"});

    const mismatches = [];
    const notRejected = [];
    for (const v of variants) {
      const body = {intent: v.intent, signature: base.signature};
      const [a, b] = await Promise.all([post(g.api, "/v1/intents", body), post(g.api, "/v1/intents/escape", body)]);
      if (a.status !== b.status || a.body?.code !== b.body?.code || a.body?.message !== b.body?.message) {
        mismatches.push({variant: v.name, submit: [a.status, a.body?.code], escape: [b.status, b.body?.code]});
      }
      if (a.status < 400 || a.status >= 500 || b.status < 400 || b.status >= 500) {
        notRejected.push({variant: v.name, submit: [a.status, a.body?.code], escape: [b.status, b.body?.code]});
      }
    }
    const ok = mismatches.length === 0 && notRejected.length === 0;
    g.record("C0-1", {
      outcome: ok ? "pass" : "finding",
      suspect: notRejected.length ? "D3" : null,
      summary: `${variants.length} variasi, ${mismatches.length} beda antar rute, ${notRejected.length} tidak ditolak sebagai 4xx`,
      evidence: {mismatches, notRejected},
    });
    assert.deepEqual(mismatches, [], "routes disagree");
    assert.deepEqual(notRejected, [], "some variants were not rejected as 4xx");
  });

  test("C0-2 out of range numbers are 400, never 502", async () => {
    const base = await validSigned();
    const results = [];
    for (const f of NUMERIC_FIELDS) {
      const bad = {
        overflow: String(2n ** BigInt(WIDTH[f])),
        negative: "-1",
        fraction: "1.5",
        nan: "NaN",
        infinity: "Infinity",
        empty: "",
        array: ["5"],
        object: {},
        hex: "0x10",
        spaced: " 5 ",
      };
      for (const [kind, value] of Object.entries(bad)) {
        const res = await post(g.api, "/v1/intents", {intent: {...base.intent, [f]: value}, signature: base.signature});
        results.push({field: f, kind, status: res.status, code: res.body?.code});
      }
    }
    const wrong = results.filter((r) => !(r.status === 400 && r.code === "COORDINATOR_INVALID_REQUEST"));
    const five = wrong.filter((r) => r.status >= 500);
    g.record("C0-2", {
      outcome: wrong.length === 0 ? "pass" : "finding",
      suspect: "D3",
      summary: `${results.length} kasus, ${five.length} jadi 5xx, ${wrong.length - five.length} lolos ke pemeriksaan berikutnya`,
      evidence: {fiveHundreds: five, acceptedAsNumber: wrong.filter((r) => r.status < 500)},
    });
    assert.deepEqual(wrong, []);
  });

  test("C0-3 the escape hatch publishes the same intent hash onchain", async () => {
    const signed = await validSigned();
    const res = await post(g.api, "/v1/intents/escape", {intent: signed.intent, signature: signed.signature});
    assert.equal(res.status, 200, res.text);

    const receipt = await sendAs({from: signed.intent.owner, to: res.body.to, data: res.body.data});
    const events = receipt.logs
      .filter((l) => l.address.toLowerCase() === ctx.deployment.settlement.toLowerCase())
      .map((l) => decodeEventLog({abi: abis.settlement, data: l.data, topics: l.topics}))
      .filter((e) => e.eventName === "IntentSubmittedOnchain");
    const onchainHash = events[0]?.args?.intentHash ?? events[0]?.args?.hash;
    const ok = events.length === 1 && onchainHash?.toLowerCase() === res.body.intentHash.toLowerCase();
    g.record("C0-3", {
      outcome: ok ? "pass" : "finding",
      summary: ok ? "tidak revert, event membawa hash yang sama" : "hash event berbeda atau event tidak ada",
      evidence: {apiHash: res.body.intentHash, eventHash: onchainHash, tx: receipt.transactionHash},
    });
    assert.ok(ok);
  });

  test("C0-4 a cold witness cache under 1000 parallel requests", {todo: "N1"}, async () => {
    await restartApi(g);
    g.proxy.resetStats();
    const signed = await validSigned();
    const body = {intent: signed.intent, signature: `0x${"11".repeat(65)}`};
    const answers = await Promise.all(Array.from({length: 1000}, () => post(g.api, "/v1/intents", body)));
    const digests = new Set(answers.map((a) => a.body?.detail?.verifiedDigest));
    const statuses = [...new Set(answers.map((a) => a.status))];
    const domainReads = g.proxy.stats.bySelector[toFunctionSelector("DOMAIN_SEPARATOR()")] ?? 0;
    const typeReads = g.proxy.stats.bySelector[toFunctionSelector("WITNESS_TYPE_STRING()")] ?? 0;
    const sameDigest = digests.size === 1 && !digests.has(undefined);
    const fewReads = domainReads <= 10 && typeReads <= 10;
    g.record("C0-4", {
      outcome: sameDigest && fewReads ? "pass" : "finding",
      summary: `${digests.size} digest berbeda, ${domainReads} baca DOMAIN_SEPARATOR, ${typeReads} baca WITNESS_TYPE_STRING`,
      evidence: {statuses, domainReads, typeReads, digests: [...digests]},
    });
    assert.ok(sameDigest, "digests differ");
    assert.ok(fewReads, `cold cache read DOMAIN_SEPARATOR ${domainReads} times`);
  });

  test("C0-5 a failed first witness read is not cached", async () => {
    await restartApi(g);
    // viem retries an internal RPC error three times, so four failures are what
    // it takes for the request to see one.
    g.proxy.setRules([{mode: "error", selectors: [toFunctionSelector("WITNESS_TYPE_STRING()")], count: 4}]);
    const first = await submit(g.api, await validSigned());
    g.proxy.pass();
    const second = await submit(g.api, await validSigned());
    const ok = first.status >= 500 && first.body?.code === "COORDINATOR_UPSTREAM_DOWN" && second.status === 200;
    g.record("C0-5", {
      outcome: ok ? "pass" : "finding",
      summary: `pertama ${first.status} ${first.body?.code}, kedua ${second.status} ${second.body?.code ?? ""}`,
      evidence: {first: first.body, second: second.body?.code ?? second.body?.status},
    });
    assert.ok(ok);
  });
});
