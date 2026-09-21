// Group C3. Read routes and the solver feed, commit 59c7b90.
//
// Weekend scenarios first, the weekday staleness scenario last, because chain
// time only moves forward inside a group.

import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {encodeAbiParameters, encodeFunctionData, keccak256, maxUint256, parseAbi, toFunctionSelector} from "viem";
import {get, post, submit} from "./lib/api.mjs";
import {SESSION, findSessionStart, leaveGuardBand} from "./lib/calendar.mjs";
import {chainNow, dealErc20, ethCall, sendAs, setStorageAt, warpTo, withSnapshot} from "./lib/fork.mjs";
import {freshWindow, manualMining, nonceSource, useGroup} from "./lib/harness.mjs";
import {NVDA, USDG, abis, ctx, makeIntent, signRaw, users} from "./lib/sign.mjs";

const g = useGroup(import.meta.url, {proxy: true});
const nextNonce = nonceSource(3);

const erc20 = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const adapterAbi = parseAbi(["function swap(address,address,uint256,uint256) returns (uint256)"]);

async function accepted(user = users[0]) {
  const s = await signRaw(makeIntent({owner: user.address, nonce: nextNonce(), now: await chainNow()}), user);
  const res = await submit(g.api, s);
  assert.equal(res.status, 200, res.text);
  return {s, res};
}

async function refPriceAt(token, blockNumber) {
  return ctx.client.readContract({
    address: ctx.deployment.oracle,
    abi: abis.oracle,
    functionName: "refPrice",
    args: [token],
    blockNumber: BigInt(blockNumber),
  });
}

const isApiError = (body) => !!body && typeof body.code === "string" && typeof body.message === "string";

describe("C3 read routes and the solver feed", () => {
  test("C3-1 intent hash spellings", async () => {
    const {res} = await accepted();
    const h = res.body.intentHash;
    const cases = {
      upper: `0x${h.slice(2).toUpperCase()}`,
      mixed: `0x${[...h.slice(2)].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join("")}`,
      noPrefix: h.slice(2),
      short63: h.slice(0, 65),
      long65: `${h}a`,
      unknown: `0x${"ab".repeat(32)}`,
    };
    const results = {};
    for (const [name, value] of Object.entries(cases)) {
      const r = await get(g.api, `/v1/intents/${value}`);
      results[name] = {status: r.status, found: r.body?.intentHash === h, shape: r.status === 200 || isApiError(r.body)};
    }
    const ok =
      results.upper.found &&
      results.mixed.found &&
      ["noPrefix", "short63", "long65", "unknown"].every((k) => results[k].status === 404 && results[k].shape);
    g.record("C3-1", {outcome: ok ? "pass" : "finding", summary: Object.entries(results).map(([k, v]) => `${k} ${v.status}`).join(", "), evidence: results});
    assert.ok(ok);
  });

  test("C3-2 batchId inputs that are not a valid batchId", {todo: "D11"}, async () => {
    const batch = await freshWindow(g.api, 10);
    const cases = {
      negative: "-1",
      zero: "0",
      over64: String(2n ** 64n),
      over256: String(2n ** 256n),
      exponent: "1e3",
      spaced: encodeURIComponent(" 123 "),
      hex: "0x10",
      empty: "",
      misaligned: String(BigInt(batch.batchId) + 1n),
    };
    const results = {};
    for (const [name, value] of Object.entries(cases)) {
      const r = await get(g.api, `/v1/batches/${value}/intents`);
      results[name] = {status: r.status, code: r.body?.code};
    }
    // Zero is aligned to every duration and sits in no guard band, so the
    // contract's own batchWindow accepts it. Either answer mirrors a real rule.
    const wrong = Object.entries(results).filter(([name, r]) => {
      if (name === "zero") return !(r.status === 200 || r.status === 400);
      if (name === "empty") return !(r.status >= 400 && r.status < 500);
      return r.status !== 400;
    });
    const five = wrong.filter(([, r]) => r.status >= 500);
    g.record("C3-2", {
      outcome: wrong.length === 0 ? "pass" : "finding",
      suspect: "D11",
      summary: Object.entries(results).map(([k, v]) => `${k} ${v.status}`).join(", "),
      evidence: {fiveHundreds: five.map(([k]) => k)},
    });
    assert.deepEqual(wrong.map(([k]) => k), []);
  });

  test("C3-3 prices match the oracle at the block the response names", async () => {
    await manualMining(async () => {
      const batch = await freshWindow(g.api, 10);
      const feed = await get(g.api, `/v1/batches/${batch.batchId}/intents`);
      assert.equal(feed.status, 200, feed.text);
      const block = feed.body.provenance.blockNumber;
      const rows = [];
      for (const row of feed.body.oraclePrices) {
        if (row.token.toLowerCase() === USDG().address.toLowerCase()) {
          rows.push({symbol: row.symbol, ok: row.price === String(10n ** 30n), price: row.price});
          continue;
        }
        const [price] = await refPriceAt(row.token, block);
        const expected = (price * 10n ** 18n) / 10n ** BigInt(row.decimals);
        rows.push({symbol: row.symbol, ok: row.price === String(expected) && row.refPrice === String(price), price: row.price, expected: String(expected)});
      }
      const bad = rows.filter((r) => !r.ok);
      g.record("C3-3", {outcome: bad.length === 0 ? "pass" : "finding", summary: `${rows.length - bad.length} dari ${rows.length} baris cocok di blok ${block}, USDG ${rows[0].price}`, evidence: {bad}});
      assert.deepEqual(bad, []);
    });
  });

  test("C3-3b the prices are read at the block provenance names", async () => {
    const batch = await freshWindow(g.api, 10);
    g.proxy.setRules([{mode: "latency", ms: 2500, selectors: [toFunctionSelector("refPrice(address)")]}]);
    let feed;
    try {
      feed = await get(g.api, `/v1/batches/${batch.batchId}/intents`);
    } finally {
      g.proxy.pass();
    }
    const nvda = feed.body?.oraclePrices?.find((r) => r.symbol === "NVDA");
    // On a frozen session refPrice stamps its answer with block.timestamp, so
    // the row carries the block it was really read at.
    const same = nvda?.updatedAt === feed.body?.provenance?.blockTimestamp;
    g.record("C3-3b", {
      outcome: same ? "pass" : "finding",
      suspect: "D8",
      summary: `provenance menyebut blok ${feed.body?.provenance?.blockNumber} (ts ${feed.body?.provenance?.blockTimestamp}), harga NVDA dibaca di ts ${nvda?.updatedAt}`,
    });
    assert.ok(same, "prices come from a later block than the provenance says");
  });

  test("C3-4 one token with no feed does not take the whole feed down", async () => {
    await withSnapshot(async () => {
      const gme = ctx.tokens.find((t) => t.symbol === "GME");
      const slot = keccak256(encodeAbiParameters([{type: "address"}, {type: "uint256"}], [gme.token, 0n]));
      await setStorageAt(ctx.deployment.oracle, slot, `0x${"00".repeat(32)}`);
      let reverts = null;
      try {
        await refPriceAt(gme.token, (await ctx.client.getBlockNumber()));
      } catch (error) {
        reverts = error.shortMessage ?? error.message;
      }
      const batch = await freshWindow(g.api, 10);
      const feed = await get(g.api, `/v1/batches/${batch.batchId}/intents`);
      const row = feed.body?.oraclePrices?.find((r) => r.symbol === "GME");
      const named = feed.body?.oracleUnavailable?.find((u) => u.symbol === "GME");
      const ok = feed.status === 200 && (row ? row.healthy === false : !!named?.reason);
      g.record("C3-4", {
        outcome: ok ? "pass" : "finding",
        suspect: "D10",
        summary: `refPrice(GME) setelah feed dikosongkan: ${reverts ? "revert" : "tidak revert"}. Feed solver ${feed.status} ${feed.body?.code ?? ""}`,
        evidence: {revert: reverts, message: feed.body?.message?.slice(0, 200), unavailable: feed.body?.oracleUnavailable, rows: feed.body?.oraclePrices?.map((r) => r.symbol)},
      });
      assert.ok(ok);
    });
  });

  test("C3-6 weekend TWAP pushed past the drift cap by a real swap", async () => {
    await withSnapshot(async () => {
      // Moving every other pool's USDG through this one shifted the TWAP by 207
      // bps, measured 21 September 2026, far short of the 1500 bps cap. So the
      // buyer's balance is written into storage instead, the way forge's deal
      // does, and the swap that follows is a real one through the pool.
      const buyer = users[0];
      await dealErc20(USDG().address, buyer.address, 1_000_000_000n * 10n ** 6n, {
        readBalance: () => ctx.client.readContract({address: USDG().address, abi: erc20, functionName: "balanceOf", args: [buyer.address]}),
      });
      await sendAs({from: buyer.address, to: USDG().address, data: encodeFunctionData({abi: erc20, functionName: "approve", args: [ctx.deployment.adapter, maxUint256]})});
      const [before] = await refPriceAt(NVDA().token, await ctx.client.getBlockNumber());
      // A swap large enough to run the price off the end of the liquidity asks
      // the pool for more NVDA than it holds, because make fund took some out.
      // So the largest amount that still settles is found by simulation.
      let moved = 0n;
      for (const whole of [5_000_000n, 4_000_000n, 3_500_000n, 3_000_000n, 2_500_000n, 2_000_000n, 1_500_000n]) {
        try {
          await ethCall({
            from: buyer.address,
            to: ctx.deployment.adapter,
            data: encodeFunctionData({abi: adapterAbi, functionName: "swap", args: [USDG().address, NVDA().token, whole * 10n ** 6n, 0n]}),
          });
          moved = whole * 10n ** 6n;
          break;
        } catch {
          // too large for what the pool holds, try the next size down
        }
      }
      assert.ok(moved > 0n, "no swap size settles against the NVDA pool");
      await sendAs({
        from: buyer.address,
        to: ctx.deployment.adapter,
        data: encodeFunctionData({abi: adapterAbi, functionName: "swap", args: [USDG().address, NVDA().token, moved, 0n]}),
        gas: 5_000_000n,
      });
      await warpTo((await chainNow()) + 1900n);

      await manualMining(async () => {
        await warpTo((await chainNow()) + 1n);
        const batch = await freshWindow(g.api, 5);
        const feed = await get(g.api, `/v1/batches/${batch.batchId}/intents`);
        const row = feed.body?.oraclePrices?.find((r) => r.symbol === "NVDA");
        const [price, , healthy] = await refPriceAt(NVDA().token, feed.body.provenance.blockNumber);
        const driftBps = Number(((price > before ? price - before : before - price) * 10_000n) / before);
        const mirrors = row && row.healthy === healthy && row.refPrice === String(price);
        const reached = healthy === false;
        g.record("C3-6", {
          outcome: !mirrors ? "finding" : reached ? "pass" : "skip",
          summary: `swap ${moved} unit USDG, TWAP NVDA bergeser ${driftBps} bps, oracle healthy ${healthy}, feed healthy ${row?.healthy}, feed ${feed.status}`,
          evidence: {before: String(before), after: String(price), note: reached ? "" : "drift tidak mencapai 1500 bps, skenario tidak terpenuhi"},
        });
        assert.ok(mirrors, "feed does not mirror refPrice at the same block");
      });
    });
  });

  test("C3-7 frozen flips one second after collectEnd", async () => {
    await manualMining(async () => {
      const batch = await freshWindow(g.api, 5);
      const collectEnd = BigInt(batch.collectEndsAt);
      const seen = [];
      for (const t of [collectEnd - 1n, collectEnd, collectEnd + 1n]) {
        await warpTo(t);
        seen.push((await get(g.api, `/v1/batches/${batch.batchId}/intents`)).body?.frozen);
      }
      const ok = seen[0] === false && seen[1] === false && seen[2] === true;
      g.record("C3-7", {outcome: ok ? "pass" : "finding", summary: `frozen di -1, 0, +1: ${seen.join(", ")}`});
      assert.ok(ok);
    });
  });

  test("C3-8 the status route's escape hatch is byte identical to the escape route", async () => {
    const {s, res} = await accepted(users[1]);
    const status = await get(g.api, `/v1/intents/${res.body.intentHash}`);
    const escape = await post(g.api, "/v1/intents/escape", {intent: s.intent, signature: s.signature});
    let simulated = true;
    try {
      await ethCall({from: s.intent.owner, to: status.body.escapeHatch.to, data: status.body.escapeHatch.data});
    } catch {
      simulated = false;
    }
    const identical = status.body?.escapeHatch?.data === escape.body?.data && status.body?.escapeHatch?.to === escape.body?.to;
    g.record("C3-8", {outcome: identical && simulated ? "pass" : "finding", summary: `calldata identik ${identical}, eth_call tidak revert ${simulated}`});
    assert.ok(identical && simulated);
  });

  test("C3-5 a stale Chainlink feed on a weekday", async () => {
    const open = await findSessionStart(SESSION.OPEN, await chainNow());
    const inside = await leaveGuardBand(open + 1n);
    await warpTo(inside + 60n);
    const feed = await get(g.api, `/v1/batches/${(await freshWindow(g.api, 5)).batchId}/intents`);
    const nvda = feed.body?.oraclePrices?.find((r) => r.symbol === "NVDA");
    const age = nvda ? feed.body.chainTime - nvda.updatedAt : null;
    const ok = feed.status === 200 && nvda?.healthy === false;
    g.record("C3-5", {
      outcome: ok ? "pass" : "finding",
      suspect: "D10",
      summary: `sesi OPEN, umur feed NVDA ${age} dtk, healthy ${nvda?.healthy}, route ${feed.status} ${feed.body?.code ?? ""}`,
      evidence: {stalenessOpen: 19000},
    });
    assert.ok(ok);
  });
});
