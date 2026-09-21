// Group C2. POST /v1/intents, commits d5934b8 and 4428678.
//
// Tests run in the order written. Everything that needs the weekend the fork
// was pinned on runs first, and the calendar scenarios that warp into weekdays
// and holidays run last, because chain time only moves forward inside a group.

import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {encodeAbiParameters, encodeFunctionData, keccak256, maxUint256, parseAbi, toFunctionSelector, toHex} from "viem";
import {loadAbi} from "../../../api/src/abi.ts";
import {get, submit, post} from "./lib/api.mjs";
import {SESSION, batchDuration, findSessionStart, inGuardBand, leaveGuardBand, sessionAt} from "./lib/calendar.mjs";
import {chainNow, ethCall, sendAs, setCode, warpTo, withSnapshot} from "./lib/fork.mjs";
import {currentBatch, freshWindow, manualMining, nonceSource, useGroup} from "./lib/harness.mjs";
import {
  NVDA,
  USDG,
  abis,
  accountsFile,
  ctx,
  digestOf,
  hashOf,
  makeIntent,
  signHash,
  signRaw,
  signatureForms,
  strangerAccount,
  users,
} from "./lib/sign.mjs";

const g = useGroup(import.meta.url, {proxy: true});
const nextNonce = nonceSource(2);

/** SPY, a real Stock Token that is not on the v1.0 allowlist. CLAUDE.md section 5. */
const SPY = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C";

const erc20 = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

async function intentFor(user, fields = {}) {
  return makeIntent({owner: user.address, nonce: nextNonce(), now: await chainNow(), ...fields});
}

async function signed(user, fields) {
  return signRaw(await intentFor(user, fields), user);
}

async function balanceOf(token, owner) {
  return ctx.client.readContract({address: token, abi: erc20, functionName: "balanceOf", args: [owner]});
}

/** Would Permit2 itself accept this signature, asked as Settlement through eth_call. */
async function permit2Accepts(intent, signature) {
  const {witnessTypeString} = {witnessTypeString: await ctx.client.readContract({
    address: ctx.deployment.settlement,
    abi: abis.settlement,
    functionName: "WITNESS_TYPE_STRING",
  })};
  const data = encodeFunctionData({
    abi: abis.permit2,
    functionName: "permitWitnessTransferFrom",
    args: [
      {permitted: {token: intent.sellToken, amount: BigInt(intent.sellAmount)}, nonce: BigInt(intent.nonce), deadline: BigInt(intent.validUntil)},
      {to: ctx.deployment.settlement, requestedAmount: BigInt(intent.sellAmount)},
      intent.owner,
      hashOf(intent),
      witnessTypeString,
      signature,
    ],
  });
  try {
    await ethCall({from: ctx.deployment.settlement, to: ctx.permit2, data});
    return true;
  } catch {
    return false;
  }
}

describe("C2 POST /v1/intents", () => {
  test("C2-1 signatures by the wrong key or over the wrong thing are 401", async () => {
    const intent = await intentFor(users[0]);
    const expected = await digestOf(intent);
    const otherDomain = keccak256(
      encodeAbiParameters(
        [{type: "bytes32"}, {type: "bytes32"}, {type: "uint256"}, {type: "address"}],
        [keccak256(toHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)")), keccak256(toHex("Permit2")), 1n, ctx.permit2],
      ),
    );
    const cases = {
      strangerKey: await strangerAccount().sign({hash: expected}),
      intentHashNotWitness: await signHash(hashOf(intent), users[0]),
      wrongSpender: await signHash(await digestOf(intent, {spender: accountsFile.solverA}), users[0]),
      otherChainDomain: await signHash(await digestOf(intent, {domainSeparator: otherDomain}), users[0]),
    };
    const results = {};
    for (const [name, signature] of Object.entries(cases)) {
      const res = await submit(g.api, {intent, signature});
      results[name] = {status: res.status, code: res.body?.code, digestMatches: res.body?.detail?.verifiedDigest === expected};
    }
    const ok = Object.values(results).every((r) => r.status === 401 && r.digestMatches);
    g.record("C2-1", {outcome: ok ? "pass" : "finding", summary: ok ? "keempatnya 401, verifiedDigest cocok" : "ada yang lolos", evidence: results});
    assert.ok(ok, JSON.stringify(results));
  });

  test("C2-2 malformed signatures never reach a 5xx", async () => {
    const intent = await intentFor(users[0]);
    const cases = {
      empty: "0x",
      oneByte: "0x11",
      zero64: `0x${"00".repeat(64)}`,
      zero65: `0x${"00".repeat(65)}`,
      huge: `0x${"ab".repeat(400_000)}`,
      oddLength: "0x123",
      notHex: "0xzz",
      noPrefix: "11".repeat(65),
    };
    const results = {};
    for (const [name, signature] of Object.entries(cases)) {
      const res = await submit(g.api, {intent, signature});
      results[name] = {status: res.status, code: res.body?.code};
    }
    const bad = Object.entries(results).filter(([, r]) => !(r.status === 400 || r.status === 401));
    g.record("C2-2", {
      outcome: bad.length === 0 ? "pass" : "finding",
      summary: bad.length === 0 ? "semua 400 atau 401" : `${bad.length} bentuk jatuh ke kode lain`,
      evidence: results,
    });
    assert.deepEqual(bad, []);
  });

  test("C2-3 the API and Permit2 agree on every encoding of a valid signature", {todo: "D14"}, async () => {
    const rows = [];
    for (const form of ["v27", "v01", "compact", "highS"]) {
      const s = await signed(users[0]);
      const signature = signatureForms(s.signature)[form];
      const res = await submit(g.api, {intent: s.intent, signature});
      const permit2 = await permit2Accepts(s.intent, signature);
      rows.push({form, api: res.status === 200 ? "diterima" : `${res.status} ${res.body?.code}`, permit2: permit2 ? "diterima" : "ditolak", agree: (res.status === 200) === permit2});
    }
    const disagree = rows.filter((r) => !r.agree);
    g.record("C2-3", {
      outcome: disagree.length === 0 ? "pass" : "finding",
      suspect: "D14",
      summary: rows.map((r) => `${r.form} api ${r.api} permit2 ${r.permit2}`).join("; "),
      evidence: {rows},
    });
    assert.deepEqual(disagree, []);
  });

  test("C2-4 an owner with code and no isValidSignature is 401 on the 1271 path", async () => {
    const intent = await intentFor(users[0], {owner: ctx.deployment.settlement, receiver: ctx.deployment.settlement});
    const res = await submit(g.api, {intent, signature: `0x${"22".repeat(65)}`});
    const ok = res.status === 401 && res.body?.detail?.path === "erc1271";
    g.record("C2-4", {outcome: ok ? "pass" : "finding", summary: `${res.status} path ${res.body?.detail?.path}`, evidence: {body: res.body}});
    assert.ok(ok);
  });

  test("C2-5 an EIP-7702 delegated owner gets the delegation message", async () => {
    await withSnapshot(async () => {
      const user = users[3];
      const s = await signed(user);
      await setCode(user.address, `0xef0100${ctx.deployment.settlement.slice(2).toLowerCase()}`);
      const res = await submit(g.api, s);
      const msg = res.body?.message ?? "";
      const ok = res.status === 401 && msg.includes("7702") && msg.includes("3C");
      g.record("C2-5", {outcome: ok ? "pass" : "finding", summary: `${res.status} ${msg}`, evidence: {path: res.body?.detail?.path}});
      assert.ok(ok);
    });
  });

  test("C2-6 a real MandateAccount on the 1271 path", async () => {
    await withSnapshot(async () => {
      const mandateAbi = loadAbi("AgentMandate");
      const owner = users[0];
      const agent = users[1];
      const now = await chainNow();
      const mandate = {
        owner: owner.address,
        agent: agent.address,
        allowedTokens: [USDG().address, NVDA().token],
        maxNotionalPerBatch: 10n ** 30n,
        maxNotionalPerDay: 10n ** 30n,
        maxDeviationFromRefBps: 10_000,
        allowedSessions: 255,
        expiry: now + 86_400n,
        auctionAllowed: false,
      };
      const created = await sendAs({
        from: owner.address,
        to: ctx.deployment.mandates,
        data: encodeFunctionData({abi: mandateAbi, functionName: "createMandate", args: [mandate]}),
      });
      const mandateCount = await ctx.client.readContract({address: ctx.deployment.mandates, abi: mandateAbi, functionName: "mandateCount", args: [owner.address]});
      const id = keccak256(encodeAbiParameters([{type: "address"}, {type: "address"}, {type: "uint256"}], [owner.address, agent.address, mandateCount - 1n]));
      const account = await ctx.client.readContract({address: ctx.deployment.mandates, abi: mandateAbi, functionName: "accountOf", args: [id]});
      const decode = (intent) => {
        const d = {...intent};
        for (const k of ["sellAmount", "minBuyAmount", "nonce"]) d[k] = BigInt(intent[k]);
        for (const k of ["validAfter", "validUntil", "flags", "kind", "maxDevFromRefBps", "allowedSessions", "batchSpan"]) d[k] = Number(intent[k]);
        return d;
      };
      const authorizeCall = async (intent) =>
        encodeFunctionData({abi: mandateAbi, functionName: "authorize", args: [id, decode(intent), await signHash(await digestOf(intent), agent)]});

      // Selling USDG is the obvious mandate, an agent buying stock with cash.
      // AgentMandate prices the sell side through PriceOracle.refPrice, which
      // tracks only stock tokens, so authorize reverts for USDG. Contracts are
      // not ours to change, so this is recorded and the path is tested with NVDA.
      const usdgIntent = makeIntent({owner: account, nonce: nextNonce(), now, flags: "3", validUntil: String(now + 3600n)});
      let usdgRevert = null;
      try {
        await ethCall({from: agent.address, to: ctx.deployment.mandates, data: await authorizeCall(usdgIntent)});
      } catch (error) {
        usdgRevert = error.message;
      }

      const nvdaFields = {sellToken: NVDA().token, buyToken: USDG().address, sellAmount: String(10n ** 18n), flags: "3", validUntil: String(now + 3600n)};
      await sendAs({from: owner.address, to: NVDA().token, data: encodeFunctionData({abi: erc20, functionName: "transfer", args: [account, 2n * 10n ** 18n]})});
      await sendAs({from: owner.address, to: account, data: encodeFunctionData({abi: parseAbi(["function approvePermit2(address)"]), functionName: "approvePermit2", args: [NVDA().token]})});

      const intent = makeIntent({owner: account, nonce: nextNonce(), now, ...nvdaFields});
      const agentSig = await signHash(await digestOf(intent), agent);
      await sendAs({from: agent.address, to: ctx.deployment.mandates, data: await authorizeCall(intent)});

      const good = await submit(g.api, {intent, signature: agentSig});
      const unbooked = makeIntent({owner: account, nonce: nextNonce(), now, ...nvdaFields});
      const bad = await submit(g.api, {intent: unbooked, signature: await signHash(await digestOf(unbooked), agent)});
      const feed = good.status === 200 ? await get(g.api, `/v1/batches/${good.body.batchId}/intents`) : null;
      const kind = feed?.body?.intents?.find((i) => i.intentHash === good.body.intentHash)?.signatureKind;
      const ok = good.status === 200 && kind === "erc1271" && bad.status === 401 && bad.body?.detail?.path === "erc1271";
      g.record("C2-6", {
        outcome: ok ? "pass" : "finding",
        summary: `yang di-authorize ${good.status} (${kind}), yang tidak ${bad.status} ${bad.body?.detail?.path}`,
        evidence: {account, tx: created.transactionHash, good: good.body?.code ?? good.body?.status, bad: bad.body?.message},
      });
      g.record("C2-6k", {
        outcome: usdgRevert ? "finding" : "pass",
        summary: usdgRevert
          ? "temuan kontrak, bukan API. AgentMandate.authorize untuk intent yang menjual USDG revert TwapSourceNotSet(USDG), karena _notional memanggil PriceOracle.refPrice(sellToken) dan oracle tidak melacak USDG. Terukur di sesi akhir pekan. Di hari kerja jalurnya lewat feed Chainlink, yang juga tidak ada untuk USDG, belum diukur. Milik Wangsit, tidak disentuh"
          : "authorize untuk intent yang menjual USDG berhasil",
        evidence: {revert: usdgRevert, lokasi: "contracts/src/AgentMandate.sol _notional, dipanggil dari authorize baris 159"},
      });
      assert.ok(ok);
    });
  });

  test("C2-7 signatureKind sent by the client is ignored", async () => {
    const s = await signed(users[0]);
    const eoa = await post(g.api, "/v1/intents", {intent: s.intent, signature: s.signature, signatureKind: "erc1271"});
    const feed = await get(g.api, `/v1/batches/${eoa.body?.batchId}/intents`);
    const storedKind = feed.body?.intents?.find((i) => i.intentHash === eoa.body?.intentHash)?.signatureKind;
    const contract = await post(g.api, "/v1/intents", {
      intent: await intentFor(users[0], {owner: ctx.deployment.settlement, receiver: ctx.deployment.settlement}),
      signature: `0x${"22".repeat(65)}`,
      signatureKind: "eoa",
    });
    const ok = eoa.status === 200 && storedKind === "eoa" && contract.body?.detail?.path === "erc1271";
    g.record("C2-7", {outcome: ok ? "pass" : "finding", summary: `EOA yang mengaku erc1271 disimpan sebagai ${storedKind}, kontrak yang mengaku eoa diperiksa lewat ${contract.body?.detail?.path}`});
    assert.ok(ok);
  });

  test("C2-8 an intent that breaks every check always reports TokenNotAllowed", async () => {
    const spyAllowed = await ctx.client.readContract({address: ctx.deployment.settlement, abi: abis.settlement, functionName: "tokenAllowed", args: [SPY]});
    assert.equal(spyAllowed, false, "SPY is on the allowlist, pick another token");
    const nonce = nextNonce();
    await sendAs({
      from: users[0].address,
      to: ctx.permit2,
      data: encodeFunctionData({abi: abis.permit2, functionName: "invalidateUnorderedNonces", args: [nonce >> 8n, 1n << (nonce % 256n)]}),
    });
    const s = await signRaw(await intentFor(users[0], {nonce: String(nonce), sellToken: SPY, sellAmount: String(10n ** 24n), allowedSessions: "0"}), users[0]);
    g.proxy.setRules([{mode: "latency", ms: 0, jitterMs: 150}]);
    const seen = {};
    try {
      for (let i = 0; i < 100; i += 1) {
        const res = await submit(g.api, s);
        const key = `${res.status} ${res.body?.code} ${res.body?.detail?.token ?? ""}`;
        seen[key] = (seen[key] ?? 0) + 1;
      }
    } finally {
      g.proxy.pass();
    }
    const ok = Object.keys(seen).length === 1 && seen[`400 TokenNotAllowed ${SPY}`] === 100;
    g.record("C2-8", {outcome: ok ? "pass" : "finding", summary: Object.entries(seen).map(([k, v]) => `${v}x ${k}`).join(", "), evidence: seen});
    assert.ok(ok);
  });

  test("C2-8b a sellToken with no code at all", {todo: "N2"}, async () => {
    const s = await signed(users[0], {sellToken: accountsFile.treasury});
    const res = await submit(g.api, s);
    const ok = res.status === 400 && res.body?.code === "TokenNotAllowed";
    g.record("C2-8b", {
      outcome: ok ? "pass" : "finding",
      summary: `sellToken berupa EOA dijawab ${res.status} ${res.body?.code}`,
      evidence: {message: res.body?.message},
    });
    assert.ok(ok);
  });

  test("C2-9 balance and allowance at exactly sellAmount and one unit short", async () => {
    await withSnapshot(async () => {
      const user = users[1];
      const balance = await balanceOf(USDG().address, user.address);
      const exactBalance = await submit(g.api, await signed(user, {sellAmount: String(balance)}));
      const overBalance = await submit(g.api, await signed(user, {sellAmount: String(balance + 1n)}));
      const limit = balance / 2n;
      await sendAs({from: user.address, to: USDG().address, data: encodeFunctionData({abi: erc20, functionName: "approve", args: [ctx.permit2, limit]})});
      const exactAllowance = await submit(g.api, await signed(user, {sellAmount: String(limit)}));
      const overAllowance = await submit(g.api, await signed(user, {sellAmount: String(limit + 1n)}));
      await sendAs({from: user.address, to: USDG().address, data: encodeFunctionData({abi: erc20, functionName: "approve", args: [ctx.permit2, maxUint256]})});
      const r = {
        exactBalance: exactBalance.status,
        overBalance: `${overBalance.status} ${overBalance.body?.code}`,
        exactAllowance: exactAllowance.status,
        overAllowance: `${overAllowance.status} ${overAllowance.body?.code}`,
      };
      const ok =
        r.exactBalance === 200 &&
        r.overBalance === "400 COORDINATOR_INSUFFICIENT_BALANCE" &&
        r.exactAllowance === 200 &&
        r.overAllowance === "400 COORDINATOR_PERMIT2_NOT_APPROVED";
      g.record("C2-9", {outcome: ok ? "pass" : "finding", summary: JSON.stringify(r), evidence: {balance: String(balance)}});
      assert.ok(ok);
    });
  });

  test("C2-10 intents the API accepts that the contract cannot settle", {todo: "D15"}, async () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const cases = {
      receiverZero: {
        fields: {receiver: zero},
        contract: "pasti gagal. Settlement.sol baris 435 safeTransfer ke receiver, token OpenZeppelin revert ERC20InvalidReceiver(0), dan seluruh finalize batch ikut revert",
        doomed: true,
      },
      sameToken: {
        fields: {buyToken: USDG().address},
        contract: "tidak ada cek eksplisit. quoteFromState(t, t) di UniswapV3Adapter tidak punya pool dan revert PoolNotSet, ditangkap di _baselineFloor sehingga batch tidak ter-price. Tidak bisa menghasilkan fill yang berarti",
        doomed: true,
      },
      sellAmountZero: {
        fields: {sellAmount: "0"},
        contract: "tidak ditolak. ClearingVerifier menerima executedSell 0 sama dengan sellAmount 0, Permit2 memindahkan 0. Intent sah tapi tidak berguna",
        doomed: false,
      },
      minBuyAmountZero: {
        fields: {minBuyAmount: "0"},
        contract: "tidak ditolak. ClearingMath.limitRespected lolos untuk batas nol, ini intent pasar yang sah",
        doomed: false,
      },
    };
    const rows = [];
    for (const [name, c] of Object.entries(cases)) {
      const res = await submit(g.api, await signed(users[0], c.fields));
      rows.push({name, api: res.status === 200 ? "diterima" : `${res.status} ${res.body?.code}`, contract: c.contract, finding: res.status === 200 && c.doomed});
    }
    const findings = rows.filter((r) => r.finding);
    g.record("C2-10", {
      outcome: findings.length === 0 ? "pass" : "finding",
      suspect: "D15",
      summary: rows.map((r) => `${r.name} api ${r.api}`).join("; "),
      evidence: {rows},
    });
    assert.deepEqual(findings.map((f) => f.name), []);
  });

  test("C2-11 a buyToken off the allowlist names the buyToken", async () => {
    const res = await submit(g.api, await signed(users[0], {buyToken: SPY}));
    const ok = res.status === 400 && res.body?.code === "TokenNotAllowed" && res.body?.detail?.token === SPY;
    g.record("C2-11", {outcome: ok ? "pass" : "finding", summary: `${res.status} ${res.body?.code} ${res.body?.detail?.token}`});
    assert.ok(ok);
  });

  test("C2-12 and C2-13 one second before collectEnd, and exactly on it", async () => {
    await manualMining(async () => {
      const batch = await freshWindow(g.api, 5);
      const collectEnd = BigInt(batch.collectEndsAt);
      const duration = collectEnd - BigInt(batch.collectStartsAt);

      await warpTo(collectEnd - 1n);
      const before = await submit(g.api, await signed(users[0]));
      const okBefore = before.body?.batchId === String(collectEnd);
      g.record("C2-12", {outcome: okBefore ? "pass" : "finding", summary: `di collectEnd - 1 masuk batch ${before.body?.batchId}, harapan ${collectEnd}`});

      await warpTo(collectEnd);
      const on = await submit(g.api, await signed(users[0]));
      const okOn = on.body?.batchId === String(collectEnd + duration);
      g.record("C2-13", {outcome: okOn ? "pass" : "finding", summary: `tepat di collectEnd masuk batch ${on.body?.batchId}, harapan ${collectEnd + duration}`});
      assert.ok(okBefore && okOn);
    });
  });

  test("C2-17a the weekend session bit is checked against the batch", async () => {
    const batch = await freshWindow(g.api, 20);
    assert.equal(batch.session, SESSION.CLOSED_WEEKEND, "fork is not in the weekend any more");
    const without = await submit(g.api, await signed(users[0], {allowedSessions: String(255 & ~(1 << SESSION.CLOSED_WEEKEND))}));
    const only = await submit(g.api, await signed(users[0], {allowedSessions: String(1 << SESSION.CLOSED_WEEKEND)}));
    const duration = batch.collectEndsAt - batch.collectStartsAt;
    const ok = without.body?.code === "SessionNotAllowed" && only.status === 200 && duration === (await batchDuration(SESSION.CLOSED_WEEKEND));
    g.record("C2-17a", {outcome: ok ? "pass" : "finding", summary: `akhir pekan, durasi ${duration} dtk, tanpa bit ${without.status} ${without.body?.code}, hanya bit ${only.status}`});
    assert.ok(ok);
  });

  test("C2-18 a slow read carries an intent past collectEnd", {todo: "D7"}, async () => {
    const batch = await freshWindow(g.api, 5);
    await warpTo(BigInt(batch.collectEndsAt) - 2n);
    const s = await signed(users[2]);
    g.proxy.setRules([{mode: "latency", ms: 5000, selectors: [toFunctionSelector("balanceOf(address)")]}]);
    let res;
    try {
      res = await submit(g.api, s);
    } finally {
      g.proxy.pass();
    }
    const after = await chainNow();
    const feed = res.status === 200 ? await get(g.api, `/v1/batches/${res.body.batchId}/intents`) : null;
    const lateAdmit = res.status === 200 && BigInt(res.body.collectEndsAt) < after && feed?.body?.frozen === true;
    g.record("C2-18", {
      outcome: lateAdmit ? "finding" : "pass",
      suspect: "D7",
      summary: lateAdmit
        ? `diterima ${res.body.status} ke batch ${res.body.batchId} yang collectEnd-nya ${res.body.collectEndsAt}, padahal chain sudah di ${after} dan feed melaporkan frozen`
        : `${res.status} ${res.body?.code ?? res.body?.batchId}`,
      evidence: {latencyMs: 5000, requestMs: res.ms, note: "latensi 5 dtk di bawah timeout viem 10 dtk, bukan 1,5 kali durasi batch"},
    });
    assert.ok(!lateAdmit, "admitted into a frozen batch");
  });

  test("C2-19 validUntil and validAfter exactly at collectEnd", async () => {
    const batch = await freshWindow(g.api, 20);
    const collectEnd = String(batch.collectEndsAt);
    const untilEdge = await submit(g.api, await signed(users[0], {validUntil: collectEnd}));
    const afterEdge = await submit(g.api, await signed(users[0], {validAfter: collectEnd}));
    const ok = untilEdge.status === 200 && afterEdge.status === 200 && untilEdge.body.batchId === collectEnd && afterEdge.body.batchId === collectEnd;
    g.record("C2-19", {outcome: ok ? "pass" : "finding", summary: `validUntil = collectEnd ${untilEdge.status}, validAfter = collectEnd ${afterEdge.status}`});
    assert.ok(ok);
  });

  test("C2-20 one owner sells the same balance twenty times", {todo: "KEPUTUSAN D4"}, async () => {
    const user = users[2];
    const balance = await balanceOf(USDG().address, user.address);
    await freshWindow(g.api, 30);
    const answers = [];
    for (let i = 0; i < 20; i += 1) answers.push(await submit(g.api, await signed(user, {sellAmount: String(balance)})));
    const accepted = answers.filter((a) => a.status === 200).length;
    const batchIds = new Set(answers.map((a) => a.body?.batchId));
    g.record("C2-20", {
      outcome: accepted > 1 ? "finding" : "pass",
      suspect: "D4",
      summary: `${accepted} dari 20 intent diterima, masing masing menjual seluruh saldo ${balance} unit USDG, di ${batchIds.size} batch`,
      evidence: {keputusan: true},
    });
    assert.ok(accepted <= 1, "KEPUTUSAN D4");
  });

  test("C2-21 conditions that change after an intent is accepted", {todo: "KEPUTUSAN N3"}, async () => {
    await withSnapshot(async () => {
      const user = users[3];
      await freshWindow(g.api, 40);
      const s = await signed(user, {sellAmount: "1000000"});
      const res = await submit(g.api, s);
      assert.equal(res.status, 200, res.text);
      const look = async (label) => {
        const status = await get(g.api, `/v1/intents/${res.body.intentHash}`);
        const feed = await get(g.api, `/v1/batches/${res.body.batchId}/intents`);
        const entry = feed.body?.intents?.find((i) => i.intentHash === res.body.intentHash);
        return {label, status: status.body?.status, rejection: status.body?.rejection, inFeed: !!entry, feedFlags: entry ? Object.keys(entry).filter((k) => !["intentHash", "intent", "signature", "signatureKind", "receivedAt"].includes(k)) : null};
      };
      const steps = [await look("baru diterima")];
      const balance = await balanceOf(USDG().address, user.address);
      await sendAs({from: user.address, to: USDG().address, data: encodeFunctionData({abi: erc20, functionName: "transfer", args: [users[0].address, balance]})});
      steps.push(await look("saldo dipindah"));
      await sendAs({from: user.address, to: USDG().address, data: encodeFunctionData({abi: erc20, functionName: "approve", args: [ctx.permit2, 0n]})});
      steps.push(await look("allowance dicabut"));
      const nonce = BigInt(s.intent.nonce);
      await sendAs({from: user.address, to: ctx.permit2, data: encodeFunctionData({abi: abis.permit2, functionName: "invalidateUnorderedNonces", args: [nonce >> 8n, 1n << (nonce % 256n)]})});
      steps.push(await look("nonce dibakar"));
      const silent = steps.slice(1).filter((st) => st.inFeed && st.status === "pending" && !st.rejection && st.feedFlags.length === 0);
      g.record("C2-21", {
        outcome: silent.length === 0 ? "pass" : "finding",
        summary: steps.map((st) => `${st.label}: ${st.status}, di feed ${st.inFeed}`).join("; "),
        evidence: {steps, keputusan: true},
      });
      assert.equal(silent.length, 0, "feed serves intents that will certainly fail with no mark");
    });
  });

  // Calendar scenarios. These warp into weekdays and holidays, so they run last.

  test("C2-14 one second before a session change, allowedSessions naming only the old one", async () => {
    await manualMining(async () => {
      const now = await chainNow();
      const change = BigInt(await ctx.client.readContract({address: ctx.deployment.sessions, abi: abis.session, functionName: "nextTransition", args: [now]}));
      await warpTo(change - 1n);
      const oldSession = await sessionAt(change - 1n);
      const res = await submit(g.api, await signed(users[0], {allowedSessions: String(1 << oldSession)}));
      const batchSession = res.body?.detail?.session;
      const named = typeof res.body?.message === "string" && res.body.message.includes(String(batchSession));
      const ok = res.body?.code === "SessionNotAllowed" && batchSession !== oldSession && named;
      g.record("C2-14", {
        outcome: ok ? "pass" : "finding",
        summary: `sesi sekarang ${oldSession}, jawaban ${res.status} ${res.body?.code}, pesan "${res.body?.message}"`,
        evidence: {change: String(change), batchSession},
      });
      assert.ok(ok);
    });
  });

  test("C2-15 inside a guard band the intent joins the first batch outside it", async () => {
    await manualMining(async () => {
      let t = (await chainNow()) + 1n;
      const change = BigInt(await ctx.client.readContract({address: ctx.deployment.sessions, abi: abis.session, functionName: "nextTransition", args: [t]}));
      t = change;
      if (!(await inGuardBand(t))) t = change - 1n;
      assert.ok(await inGuardBand(t), "no guard band found around the next transition");
      await warpTo(t);
      const current = await currentBatch(g.api);
      const res = await submit(g.api, await signed(users[0]));
      const clear = !(await inGuardBand(BigInt(res.body?.batchId ?? 0)));
      const ok = res.status === 200 && res.body.batchId === current.batchId && clear;
      g.record("C2-15", {
        outcome: ok ? "pass" : "finding",
        summary: `di band pada ${t}, POST ke ${res.body?.batchId}, current ${current.batchId}, batch di luar band ${clear}`,
      });
      assert.ok(ok);
    });
  });

  for (const [id, session] of [["C2-16a", SESSION.AUCTION_OPEN], ["C2-16b", SESSION.AUCTION_CLOSE]]) {
    test(`${id} during an auction phase`, {todo: "KEPUTUSAN N4"}, async () => {
      await manualMining(async () => {
        const start = await findSessionStart(session, await chainNow());
        await warpTo(start + 60n);
        const res = await submit(g.api, await signed(users[0]));
        const current = await currentBatch(g.api);
        const ok = res.status === 503 && res.body?.code === "COORDINATOR_NO_OPEN_BATCH" && res.body?.detail?.reason === "auction_phase";
        g.record(id, {
          outcome: ok ? "pass" : "finding",
          summary: `sesi ${session} pada ${start + 60n}, POST ${res.status} ${res.body?.code ?? ""} batch ${res.body?.batchId ?? "-"} sesi ${res.body?.batchId ? await sessionAt(res.body.batchId) : "-"}, current ${current.batchId} (${current.reason ?? current.sessionName})`,
          evidence: {keputusan: !ok, note: "check-batch menegaskan nextValidBatchId melompati fase lelang ke batch berikutnya"},
        });
        assert.ok(ok, "plan expects 503 auction_phase");
      });
    });
  }

  test("C2-17b a holiday batch uses the holiday duration and bit", async () => {
    await manualMining(async () => {
      const start = await findSessionStart(SESSION.HOLIDAY, await chainNow());
      const inside = await leaveGuardBand(start + 1n);
      await warpTo(inside + 120n);
      const batch = await currentBatch(g.api);
      const without = await submit(g.api, await signed(users[0], {allowedSessions: String(255 & ~(1 << SESSION.HOLIDAY))}));
      const only = await submit(g.api, await signed(users[0], {allowedSessions: String(1 << SESSION.HOLIDAY)}));
      const duration = batch.collectEndsAt - batch.collectStartsAt;
      const ok = batch.session === SESSION.HOLIDAY && without.body?.code === "SessionNotAllowed" && only.status === 200 && duration === (await batchDuration(SESSION.HOLIDAY));
      g.record("C2-17b", {
        outcome: ok ? "pass" : "finding",
        summary: `libur mulai ${start} (${new Date(Number(start) * 1000).toISOString()}), durasi ${duration} dtk, tanpa bit ${without.status} ${without.body?.code}, hanya bit ${only.status}`,
      });
      assert.ok(ok);
    });
  });
});
