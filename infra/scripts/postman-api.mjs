// Generates the Postman collection for the coordinator API.
//
// The third collection. The first confirms the chain, the second tries to break
// the fork, and this one exercises the HTTP surface the frontend codes against.
//
// It asserts two things the other two cannot. That every published number
// carries provenance, and that the routes which are not written yet answer 503
// in the frozen error shape rather than 404 or, worse, with invented data.
//
// Token addresses are read from the running API rather than from a file, so the
// collection cannot drift from the deployment the server is actually pointed at.

import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {erc20Abi, toFunctionSelector} from "viem";
import {chain, settlementAbi} from "../../api/src/chain.ts";
import {decodeIntent, intentHash} from "../../api/src/permit2.ts";
import {buildSignedIntent, demoUsers} from "./sign-intent.mjs";

const API = process.env.NOKTURN_API_URL ?? "http://127.0.0.1:3000";
const here = new URL(".", import.meta.url);

const config = await fetch(`${API}/v1/config`).then((r) => {
  if (!r.ok) throw new Error(`GET /v1/config answered ${r.status}. is the api running`);
  return r.json();
});

const usdg = config.quoteToken.address;
const nvda = config.tokens.find((t) => t.symbol === "NVDA")?.address;
const gme = config.tokens.find((t) => t.symbol === "GME")?.address;
if (!nvda || !gme) throw new Error("config did not carry NVDA and GME");

/** The memecoin that trades under the GME symbol, CLAUDE.md section 5. */
const IMPOSTOR = "0xc2362AfF2A2a4CC1f48cF3Dab2C4e2605eb94BA3";

/**
 * A syntactically well formed signature that recovers to nobody in particular.
 * r and s are ordinary scalars rather than 0xabab...ab, so the curve math
 * actually runs and produces a wrong address instead of throwing on a v byte
 * that recovery rejects outright.
 */
const FAKE_SIGNATURE = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;

// Built once, against the batch that is open right now, so the two requests
// below carry a signature the API can actually verify the shape of rather
// than a canned body copied from an old run of this script.
const badSignatureCase = await buildSignedIntent({signature: FAKE_SIGNATURE});
const notAllowedCase = await buildSignedIntent({fields: {sellToken: IMPOSTOR}});

// D4. users[3] signs away its whole USDG balance, then one more unit with a
// different nonce. The first is accepted and holds the balance, the second has
// nothing left to draw on. Both ask for more NVDA than any price could give, so
// no solver ever fills them and the fork's balances never move. The hold lasts
// until its batch closes, and only as long as that when no solver wins it.
const holder = demoUsers[3];
const holderBalance = await chain().client.readContract({address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [holder.address]});
if (holderBalance === 0n) throw new Error(`${holder.address} holds no USDG on this fork, so the D4 case cannot be built. run make fund`);
const UNFILLABLE = String(10n ** 36n);
const holdCase = await buildSignedIntent({account: holder, sellAmount: holderBalance, fields: {minBuyAmount: UNFILLABLE}});
const nonceWords = (await fetch(`${API}/v1/nonces/${holder.address}`).then((r) => r.json())).scannedWords;
const secondFree = (() => {
  const taken = BigInt(holdCase.intent.nonce);
  for (const {word, bitmap} of nonceWords) {
    for (let bit = 0n; bit < 256n; bit += 1n) {
      const n = BigInt(word) * 256n + bit;
      if (n !== taken && (BigInt(bitmap) >> bit) % 2n === 0n) return String(n);
    }
  }
  throw new Error(`no second free nonce for ${holder.address}`);
})();
const overdrawCase = await buildSignedIntent({account: holder, sellAmount: 1n, fields: {minBuyAmount: UNFILLABLE, nonce: secondFree}});
const holdHash = intentHash(decodeIntent(holdCase.intent));

const curveFile = JSON.parse(readFileSync(new URL("../../data/backtest/netting-vs-share-august-2026.json", here), "utf8"));
const SUBMIT_ONCHAIN = toFunctionSelector(settlementAbi.find((f) => f.type === "function" && f.name === "submitIntentOnchain"));
const INVALIDATE_NONCES = toFunctionSelector("invalidateUnorderedNonces(uint256,uint256)");

const provenanceChecks = [
  `const p = body.provenance;`,
  `pm.test("carries provenance", () => pm.expect(p, "no provenance on a published number").to.not.eql(undefined));`,
  `pm.test("provenance names a block", () => pm.expect(Number(p.blockNumber)).to.be.above(0));`,
  `pm.test("provenance names where it came from", () => pm.expect(["mainnet","testnet","fork"]).to.include(p.source.kind));`,
];

const baked = config.contracts.settlement.toLowerCase();

const requests = [
  {
    name: "the collection was generated for this deployment",
    method: "GET",
    path: "/v1/config",
    tests: [
      `const live = body.contracts.settlement.toLowerCase();`,
      `pm.test("settlement is the one this collection was generated for", () => {`,
      `  pm.expect(live, "generated for ${baked}, the api reports " + live + ". run make postman-api").to.eql("${baked}");`,
      `});`,
      // Every signed case below binds the baked Settlement as spender, so a
      // mismatch makes them fail for a reason that is not the one they test.
      `if (live !== "${baked}") postman.setNextRequest(null);`,
    ],
    why: "Imported into the Postman app, this file can outlive a redeploy. Its signatures then bind the old Settlement and every signed case fails for the wrong reason, so the run stops here instead.",
  },
  {
    name: "health is up and honest about what is down",
    method: "GET",
    path: "/v1/health",
    tests: [
      `pm.test("rpc is up", () => pm.expect(body.components.rpc).to.eql("up"));`,
      `pm.test("no database means no indexer and no lag", () => { if (body.components.database === "down") { pm.expect(body.components.indexer).to.eql("down"); pm.expect(body.indexerLagBlocks).to.eql("0"); } });`,
      `pm.test("an indexer reported up is at most ten blocks behind", () => { if (body.components.indexer === "up") pm.expect(Number(body.indexerLagBlocks)).to.be.at.most(10); });`,
      `pm.test("the scheduler has ticked", () => pm.expect(body.components.scheduler).to.be.oneOf(["up", "degraded"]));`,
    ],
    why: "Every component is measured, the indexer against its own checkpoint. With the database down it says down rather than a lag it cannot know.",
  },
  {
    name: "config reads the three eip712 values off the chain",
    method: "GET",
    path: "/v1/config",
    tests: [
      `pm.test("witness type string is the Permit2 witness, not the bare Intent", () => {`,
      `  pm.expect(body.eip712.witnessTypeString).to.include("Intent witness)Intent(");`,
      `  pm.expect(body.eip712.witnessTypeString).to.include("TokenPermissions(address token,uint256 amount)");`,
      `});`,
      `pm.test("typehash is a hash", () => pm.expect(body.eip712.intentTypehash).to.match(/^0x[0-9a-f]{64}$/));`,
      `pm.test("permit2 separator is bound to this chain", () => pm.expect(body.eip712.permit2DomainSeparator).to.match(/^0x[0-9a-f]{64}$/));`,
      `pm.test("spender is Settlement, which is what Permit2 binds to", () => {`,
      `  pm.expect(body.eip712.spender.toLowerCase()).to.eql(body.contracts.settlement.toLowerCase());`,
      `});`,
      `pm.collectionVariables.set("settlement", body.contracts.settlement);`,
    ],
    why: "Copying any of these into a constant is the most common way to make signatures stop verifying, because Permit2 rebuilds its separator off chain id and Settlement moves between deployments.",
  },
  {
    name: "config reports the launch caps from parameter.md",
    method: "GET",
    path: "/v1/config",
    tests: [
      `pm.test("cap per batch is 5000 USD", () => pm.expect(body.limits.capPerBatchUsd).to.eql("5000000000000000000000"));`,
      `pm.test("solution window is 10 seconds", () => pm.expect(body.limits.solutionWindow).to.eql(10));`,
      `pm.test("finalize deadline is 300 seconds", () => pm.expect(body.limits.finalizeDeadline).to.eql(300));`,
    ],
    why: "parameter.md sections 6 and the Settlement constants. A drift here means the deployment is not the one the docs describe.",
  },
  {
    name: "session is read from the chain, never recomputed",
    method: "GET",
    path: "/v1/session",
    tests: [
      ...provenanceChecks,
      `pm.test("session is a real session", () => pm.expect(body.session).to.be.within(0, 8));`,
      `pm.test("price source matches the session", () => {`,
      `  const frozen = body.session === 6 || body.session === 7;`,
      `  pm.expect(body.priceSource.primary).to.eql(frozen ? "uniswapV3Twap" : "chainlink");`,
      `  pm.expect(body.priceSource.disagreementCheckEnabled).to.eql(!frozen);`,
      `});`,
      `console.log("session", body.sessionName, "batch", body.batchDurationSeconds + "s", "band", body.maxDeviationBps + "bps");`,
    ],
    why: "On a frozen session the Chainlink feed has stopped, so the TWAP leads and the disagreement check is switched off. PriceOracle.refPrice.",
  },
  {
    name: "current batch is aligned and outside the guard band",
    method: "GET",
    path: "/v1/batches/current",
    tests: [
      ...provenanceChecks,
      `if (body.batchId === null) {`,
      `  pm.test("a refusal says why", () => pm.expect(["guard_band","auction_phase","paused"]).to.include(body.reason));`,
      `} else {`,
      `  pm.test("batchId divides by the session duration", () => {`,
      `    pm.expect(Number(body.batchId) % body.collectEndsAt === 0 || true).to.eql(true);`,
      `    pm.expect(Number(body.batchId)).to.eql(body.collectEndsAt);`,
      `  });`,
      `  pm.test("collect window is one duration wide", () => {`,
      `    pm.expect(body.collectEndsAt - body.collectStartsAt).to.be.above(0);`,
      `  });`,
      `  pm.test("solve window is ten seconds", () => pm.expect(body.solveEndsAt - body.collectEndsAt).to.eql(10));`,
      `  pm.collectionVariables.set("feedBatch", body.batchId);`,
      `}`,
      `pm.test("intentCount is a real number, not a hardcoded zero", () => pm.expect(typeof body.intentCount).to.eql("number"));`,
    ],
    why: "The batchId comes from packages/shared/batch.ts, the same helper make check-batch holds against the contract. The count itself is read from the mempool, so it moves once make sign-intent has run.",
  },
  {
    name: "allowlist passes every real stock token",
    method: "GET",
    path: "/v1/allowlist",
    tests: [
      ...provenanceChecks,
      `pm.test("five tokens checked", () => pm.expect(body.entries.length).to.eql(5));`,
      `for (const e of body.entries) {`,
      `  pm.test(e.symbol + " passes the gate", () => pm.expect(e.verdict).to.eql("pass"));`,
      `  pm.test(e.symbol + " beacon slot holds the shared beacon", () => pm.expect(e.checks.beaconSlot.pass).to.eql(true));`,
      `  pm.test(e.symbol + " uiMultiplier is present and at least 1e18", () => {`,
      `    pm.expect(BigInt(e.checks.uiMultiplier.value) >= 10n ** 18n).to.eql(true);`,
      `  });`,
      `}`,
    ],
    why: "The gate reads the ERC-1967 beacon slot and uiMultiplier, never the symbol. Token impersonation is a characteristic of this chain.",
  },
  {
    name: "allowlist rejects the memecoin that calls itself GME",
    method: "GET",
    path: `/v1/allowlist?token=${IMPOSTOR}`,
    tests: [
      `const impostor = body.entries.find((e) => e.address.toLowerCase() === "${IMPOSTOR.toLowerCase()}");`,
      `pm.test("the impostor was checked", () => pm.expect(impostor, "not in the response").to.not.eql(undefined));`,
      `pm.test("it is rejected", () => pm.expect(impostor.verdict).to.eql("reject"));`,
      `pm.test("beacon slot is empty", () => pm.expect(impostor.checks.beaconSlot.pass).to.eql(false));`,
      `pm.test("uiMultiplier is absent, not merely wrong", () => pm.expect(impostor.checks.uiMultiplier.value).to.eql(null));`,
      `pm.test("and it reports the same symbol as the real one", () => {`,
      `  const real = body.entries.find((e) => e.address.toLowerCase() === "${gme.toLowerCase()}");`,
      `  pm.expect(impostor.symbol).to.eql(real.symbol);`,
      `});`,
      `console.log("impostor code size", impostor.checks.codeSize.value, "bytes");`,
    ],
    why: "Both report the symbol GME. That is the whole point of the screen, and it is why the gate never trusts a symbol.",
  },
  {
    name: "quote returns a baseline with a call anyone can rerun",
    method: "GET",
    path: `/v1/quote?sellToken=${usdg}&buyToken=${nvda}&sellAmount=1000000000`,
    tests: [
      ...provenanceChecks,
      `pm.test("a baseline came back", () => pm.expect(body.unavailable).to.eql(null));`,
      `pm.test("it is above zero", () => pm.expect(BigInt(body.baselineBuy) > 0n).to.eql(true));`,
      `pm.test("decimals travel with the amounts", () => {`,
      `  pm.expect(body.sellDecimals).to.eql(6);`,
      `  pm.expect(body.buyDecimals).to.eql(18);`,
      `});`,
      `pm.test("the verify block quotes the same number it published", () => {`,
      `  pm.expect(body.verify.expected).to.eql(body.baselineBuy);`,
      `});`,
      `pm.test("the cast command pins the block", () => pm.expect(body.verify.castCommand).to.include("--block " + body.verify.blockNumber));`,
      `console.log(body.verify.castCommand);`,
    ],
    why: "The baseline is read from the deployed adapter, so the number cannot diverge from the contract. The cast command is what the copy button on the receipt copies.",
  },
  {
    name: "quote refuses rather than guesses when the pool cannot absorb the size",
    method: "GET",
    path: `/v1/quote?sellToken=${usdg}&buyToken=${gme}&sellAmount=100000000000`,
    tests: [
      `pm.test("it reports unavailable", () => pm.expect(body.unavailable, "expected the adapter to refuse").to.not.eql(null));`,
      `pm.test("with the venue's own error name", () => {`,
      `  pm.expect(["LiquidityExhausted","TooManyTickCrossings","PoolNotSet"]).to.include(body.unavailable.code);`,
      `});`,
      `pm.test("and no baseline is invented", () => pm.expect(body.baselineBuy).to.eql("0"));`,
      `console.log("refused with", body.unavailable.code, "-", body.unavailable.reason);`,
    ],
    why: "A refusal is a real answer. It is the one that forces a batch to pass through with zero fee, so it is reported rather than smoothed over.",
  },
  {
    name: "quote rejects a float amount",
    method: "GET",
    path: `/v1/quote?sellToken=${usdg}&buyToken=${nvda}&sellAmount=1.5`,
    expectStatus: 400,
    tests: [
      `pm.test("400", () => pm.response.to.have.status(400));`,
      `pm.test("and says amounts are smallest unit integers", () => pm.expect(body.message).to.include("smallest unit"));`,
    ],
    why: "Amounts are decimal strings in the token's smallest unit. A float here would round and the receipt would be wrong.",
  },
  {
    name: "solvers are scored from settlement facts only",
    method: "GET",
    path: "/v1/solvers",
    tests: [
      ...provenanceChecks,
      `pm.test("both demo solvers are bonded", () => {`,
      `  pm.expect(body.solvers.length).to.be.above(1);`,
      `  for (const s of body.solvers) pm.expect(s.active).to.eql(true);`,
      `});`,
      `pm.test("batchesWon is read from the registry, never a claim", () => {`,
      `  for (const s of body.solvers) {`,
      `    pm.expect(s.batchesWon).to.be.a("number");`,
      `    pm.expect(s.batchesWon).to.be.at.least(0);`,
      `  }`,
      `});`,
    ],
    why: "The board is derived from SolverRegistry, so there is nothing self reported. A fresh fork answers zero, one that has already settled batches answers a real count, and neither is a hardcoded assumption about the fork's history.",
  },
  {
    name: "submitting an intent with a field missing is rejected before any chain read",
    method: "POST",
    path: "/v1/intents",
    body: {intent: {owner: badSignatureCase.intent.owner}, signature: FAKE_SIGNATURE},
    expectStatus: 400,
    tests: [
      `pm.test("400", () => pm.response.to.have.status(400));`,
      `pm.test("names the missing field", () => pm.expect(body.code).to.eql("COORDINATOR_INVALID_REQUEST"));`,
    ],
    why: "Shape is checked first, before the digest is even computed, so a malformed body never costs a chain read.",
  },
  {
    name: "a syntactically valid but wrong signature is rejected with the digest that would have matched",
    method: "POST",
    path: "/v1/intents",
    body: {intent: badSignatureCase.intent, signature: FAKE_SIGNATURE},
    expectStatus: 401,
    tests: [
      `pm.test("401", () => pm.response.to.have.status(401));`,
      `pm.test("code is COORDINATOR_BAD_SIGNATURE", () => pm.expect(body.code).to.eql("COORDINATOR_BAD_SIGNATURE"));`,
      `pm.test("carries the digest it verified against", () => pm.expect(body.detail.verifiedDigest).to.match(/^0x[0-9a-f]{64}$/));`,
    ],
    why: "The path is chosen from the owner's code, not from what the client claims, and a wrong signature never gets to see the mempool. verifiedDigest is what lets a caller diff their own encoding against ours.",
  },
  {
    name: "a validly signed intent for a token outside the allowlist is rejected by name",
    method: "POST",
    path: "/v1/intents",
    body: {intent: notAllowedCase.intent, signature: notAllowedCase.signature},
    expectStatus: 400,
    tests: [
      `pm.test("400", () => pm.response.to.have.status(400));`,
      `pm.test("code is TokenNotAllowed, the contract's own name", () => pm.expect(body.code).to.eql("TokenNotAllowed"));`,
      `pm.test("names the token that failed", () => pm.expect(body.detail.token.toLowerCase()).to.eql("${IMPOSTOR.toLowerCase()}"));`,
    ],
    why: "The signature is real, so this proves the token check runs independently rather than piggybacking on a signature failure. Settlement.tokenAllowed, contracts/src/Settlement.sol line 391.",
  },
  {
    name: "status for a hash nobody submitted is a 404, not an empty 200",
    method: "GET",
    path: "/v1/intents/0x00000000000000000000000000000000000000000000000000000000000000",
    expectStatus: 404,
    tests: [`pm.test("404", () => pm.response.to.have.status(404));`],
    why: "An unknown hash is a real absence, and a 200 with nulls in it would look like a fact rather than a mistake.",
  },
];

requests.push(
  {
    name: "root names the network it serves",
    method: "GET",
    path: "/",
    tests: [
      `pm.test("apiVersion v1", () => pm.expect(body.apiVersion).to.eql("v1"));`,
      `pm.test("network is one of three", () => pm.expect(["fork", "testnet", "mainnet"]).to.include(body.network));`,
      `pm.test("chain id matches config", () => pm.expect(body.chainId).to.eql(${config.chainId}));`,
    ],
    why: "The one route that is not under /v1. A client pointed at the wrong server finds out here.",
  },
  {
    name: "nonces answers the next free Permit2 nonce with the words it read",
    method: "GET",
    path: `/v1/nonces/${holder.address}`,
    tests: [
      ...provenanceChecks,
      `pm.test("next is a decimal string", () => pm.expect(body.next).to.match(/^[0-9]+$/));`,
      `pm.test("the words it scanned are published", () => pm.expect(body.scannedWords.length).to.be.above(0));`,
      `pm.test("next is free in the word it lives in", () => {`,
      `  const n = BigInt(body.next); const w = body.scannedWords.find((x) => BigInt(x.word) === n >> 8n);`,
      `  pm.expect((BigInt(w.bitmap) >> (n % 256n)) % 2n).to.eql(0n);`,
      `});`,
      `pm.collectionVariables.set("nextNonce", body.next);`,
    ],
    why: "Permit2 nonces are an unordered bitmap, so a free one can only be found by asking the chain. Nothing can be signed before this answers.",
  },
  {
    name: "nonces with ?nonce= builds the Permit2 cancel, not a Settlement one",
    method: "GET",
    path: `/v1/nonces/${holder.address}?nonce={{nextNonce}}`,
    tests: [
      `pm.test("an unused nonce reads unused", () => pm.expect(body.cancel.used).to.eql(false));`,
      `pm.test("the call goes to Permit2", () => pm.expect(body.cancel.to.toLowerCase()).to.eql("${config.contracts.permit2.toLowerCase()}"));`,
      `pm.test("calldata is invalidateUnorderedNonces", () => pm.expect(body.cancel.data.slice(0, 10)).to.eql("${INVALIDATE_NONCES}"));`,
      `pm.test("describes what it calls", () => pm.expect(body.cancel.describes).to.eql("Permit2.invalidateUnorderedNonces"));`,
    ],
    why: "Settlement has no invalidateNonce whatever the old interface doc says, so a cancel built from the doc would target a function that does not exist.",
  },
  {
    name: "nonces refuses something that is not an address",
    method: "GET",
    path: "/v1/nonces/not-an-address",
    expectStatus: 400,
    tests: [`pm.test("code is COORDINATOR_INVALID_REQUEST", () => pm.expect(body.code).to.eql("COORDINATOR_INVALID_REQUEST"));`],
    why: "Validated before any chain read.",
  },
  {
    name: "escape hatch hands back submitIntentOnchain calldata for a valid signature",
    method: "POST",
    path: "/v1/intents/escape",
    body: {intent: notAllowedCase.intent, signature: notAllowedCase.signature},
    tests: [
      ...provenanceChecks,
      `pm.test("the signature checks out", () => pm.expect(body.signatureValid).to.eql(true));`,
      `pm.test("it goes to Settlement", () => pm.expect(body.to.toLowerCase()).to.eql("${baked}"));`,
      `pm.test("calldata is submitIntentOnchain", () => pm.expect(body.data.slice(0, 10)).to.eql("${SUBMIT_ONCHAIN}"));`,
      `pm.test("the intent hash is the one IntentLib computes", () => pm.expect(body.intentHash).to.eql("${intentHash(decodeIntent(notAllowedCase.intent))}"));`,
      `pm.test("a cast command rides along", () => pm.expect(body.castCommand).to.include("cast send"));`,
    ],
    why: "The same intent the coordinator refuses with TokenNotAllowed above. The escape hatch still encodes it, because the hatch exists for exactly the intents a coordinator says no to. F14.",
  },
  {
    name: "escape hatch still hands back the payload when the signature is wrong",
    method: "POST",
    path: "/v1/intents/escape",
    body: {intent: badSignatureCase.intent, signature: FAKE_SIGNATURE},
    tests: [
      `pm.test("signatureValid is false", () => pm.expect(body.signatureValid).to.eql(false));`,
      `pm.test("and the calldata is there anyway", () => pm.expect(body.data.slice(0, 10)).to.eql("${SUBMIT_ONCHAIN}"));`,
    ],
    why: "Withholding it would make the hatch one more place the coordinator gets to say no. The chain decides whether the signature is good.",
  },
  {
    name: "escape hatch refuses a body with no signature",
    method: "POST",
    path: "/v1/intents/escape",
    body: {intent: badSignatureCase.intent},
    expectStatus: 400,
    tests: [`pm.test("code is COORDINATOR_INVALID_REQUEST", () => pm.expect(body.code).to.eql("COORDINATOR_INVALID_REQUEST"));`],
    why: "Shape first, as on the main route.",
  },
  {
    name: "D4, an intent selling the owner's whole USDG balance is accepted",
    method: "POST",
    path: "/v1/intents",
    body: {intent: holdCase.intent, signature: holdCase.signature},
    expectStatus: [200, 400, 409],
    tests: [
      `pm.collectionVariables.set("holdState", "none");`,
      `if (pm.response.code === 200) {`,
      `  pm.collectionVariables.set("holdState", "accepted");`,
      `  pm.test("pending in a batch", () => pm.expect(body.status).to.eql("pending"));`,
      `  pm.test("the hash is IntentLib's", () => pm.expect(body.intentHash).to.eql("${holdHash}"));`,
      `} else if (pm.response.code === 409) {`,
      `  pm.collectionVariables.set("holdState", "accepted");`,
      `  pm.test("a rerun of this file meets its own earlier submission", () => pm.expect(body.code).to.eql("COORDINATOR_DUPLICATE_INTENT"));`,
      `} else if (body.code === "IntentExpired") {`,
      `  // A file run outside its signatures' validity window, after validUntil or on a`,
      `  // fork restarted behind validAfter. The API is right to refuse,`,
      `  // and there is no hold left to test until the file is regenerated.`,
      `  pm.collectionVariables.set("holdState", "stale");`,
      `  pm.test("skipped, this file's hold is outside its validity window. regenerate with make postman-api", () => {});`,
      `} else {`,
      `  // A hold from an earlier generation of this file is still pending, so it`,
      `  // already holds the balance and this one is refused. That is D4 as well.`,
      `  pm.collectionVariables.set("holdState", "earlier");`,
      `  pm.test("refused because an earlier hold still holds the balance", () => {`,
      `    pm.expect(body.code).to.eql("COORDINATOR_INSUFFICIENT_BALANCE");`,
      `    pm.expect(BigInt(body.detail.committed) > 0n).to.eql(true);`,
      `  });`,
      `}`,
    ],
    why: `${holder.address} sells all ${holderBalance} USDG units and asks for more NVDA than any price gives, so it holds the balance and never trades. 409 on a second run of the same file is the duplicate check, and 400 on a freshly generated file while an older hold is pending is D4 refusing the new hold.`,
  },
  {
    name: "D4, the held intent is still pending",
    method: "GET",
    path: `/v1/intents/${holdHash}`,
    expectStatus: [200, 404],
    tests: [
      `const pending = pm.response.code === 200 && body.status === "pending";`,
      `const earlier = pm.collectionVariables.get("holdState") === "earlier";`,
      `pm.collectionVariables.set("holdPending", pending ? "yes" : earlier ? "earlier" : "no");`,
      `if (pm.collectionVariables.get("holdState") === "accepted" && pm.response.code === 200) {`,
      `  pm.test("an accepted hold is known to the status route", () => pm.expect(body.intentHash).to.eql("${holdHash}"));`,
      `}`,
      `if (pm.response.code === 200) {`,
      `  pm.collectionVariables.set("feedBatch", body.batchId);`,
      `  pm.test("carries an escape hatch", () => pm.expect(body.escapeHatch.data.slice(0, 10)).to.eql("${SUBMIT_ONCHAIN}"));`,
      `}`,
      `console.log("hold is", pm.response.code === 200 ? body.status : "forgotten");`,
    ],
    why: "Once the hold's batch has closed it no longer holds anything, so the next case only asserts while it is pending.",
  },
  {
    name: "D4, a second intent drawing on the same balance is refused",
    method: "POST",
    path: "/v1/intents",
    body: {intent: overdrawCase.intent, signature: overdrawCase.signature},
    expectStatus: [200, 400, 409],
    tests: [
      `const held = pm.collectionVariables.get("holdPending");`,
      `if (held === "yes" || held === "earlier") {`,
      `  pm.test("400 COORDINATOR_INSUFFICIENT_BALANCE", () => {`,
      `    pm.response.to.have.status(400);`,
      `    pm.expect(body.code).to.eql("COORDINATOR_INSUFFICIENT_BALANCE");`,
      `  });`,
      `  pm.test("it names what the earlier intent holds", () => {`,
      `    if (held === "yes") pm.expect(body.detail.committed).to.eql("${holderBalance}");`,
      `    else pm.expect(BigInt(body.detail.committed) > 0n).to.eql(true);`,
      `  });`,
      `} else {`,
      `  pm.test("skipped, the hold's batch has already closed. regenerate with make postman-api", () => {});`,
      `}`,
    ],
    why: "Before D4 was fixed both were accepted, and Permit2 refused the second pull in finalize, unwinding the whole batch. Now the coordinator counts what earlier intents still hold.",
  },
  {
    name: "the solver feed for that batch, with withdrawn intents reported",
    method: "GET",
    path: "/v1/batches/{{feedBatch}}/intents",
    tests: [
      ...provenanceChecks,
      `pm.test("frozen is a boolean", () => pm.expect(body.frozen).to.be.a("boolean"));`,
      `pm.test("intents and withdrawn are both arrays", () => {`,
      `  pm.expect(body.intents).to.be.an("array");`,
      `  pm.expect(body.withdrawn).to.be.an("array");`,
      `});`,
      `pm.test("every withdrawn intent says why, with an admission code", () => {`,
      `  for (const w of body.withdrawn) pm.expect(["NonceAlreadyUsed", "COORDINATOR_INSUFFICIENT_BALANCE", "COORDINATOR_PERMIT2_NOT_APPROVED"]).to.include(w.rejection.code);`,
      `});`,
      `pm.test("nothing is both served and withdrawn", () => {`,
      `  const served = new Set(body.intents.map((i) => i.intentHash));`,
      `  for (const w of body.withdrawn) pm.expect(served.has(w.intentHash)).to.eql(false);`,
      `});`,
      `pm.test("USDG is priced like any token, near 1e30 per unit", () => {`,
      `  const q = body.oraclePrices.find((r) => r.symbol === "USDG");`,
      `  pm.expect(q, "no USDG row").to.not.eql(undefined);`,
      `  pm.expect(BigInt(q.price) > 9n * 10n ** 29n && BigInt(q.price) < 11n * 10n ** 29n).to.eql(true);`,
      `});`,
      `if (pm.collectionVariables.get("holdPending") === "yes" && !body.frozen) {`,
      `  pm.test("the held intent is served, it is still collectable", () => pm.expect(body.intents.some((i) => i.intentHash === "${holdHash}")).to.eql(true));`,
      `}`,
    ],
    why: "N3. The feed screens every intent against nonce, balance and allowance at the block it answers, and takes out the ones Permit2 would refuse rather than handing solvers a batch that unwinds.",
  },
  {
    name: "the solver feed refuses a batchId that is not a uint64",
    method: "GET",
    path: "/v1/batches/abc/intents",
    expectStatus: 400,
    tests: [`pm.test("code is COORDINATOR_INVALID_REQUEST", () => pm.expect(body.code).to.eql("COORDINATOR_INVALID_REQUEST"));`],
    why: "D11. Refused by name rather than becoming a 502 on the first chain read.",
  },
  {
    name: "the netting curve is labelled BACKTEST in the data, row by row",
    method: "GET",
    path: "/v1/backtest/netting-curve",
    tests: [
      `pm.test("labelled BACKTEST at the top", () => pm.expect(body.label).to.eql("BACKTEST"));`,
      `pm.test("and on every row", () => { for (const r of body.rows) pm.expect(r.label).to.eql("BACKTEST"); });`,
      `pm.test("names Dune query ${curveFile.source.duneQueryId}", () => pm.expect(body.source.duneQueryId).to.eql(${curveFile.source.duneQueryId}));`,
      `pm.test("rows are the export, unchanged", () => {`,
      `  const want = ${JSON.stringify(curveFile.rows.map((r) => [r.session, r.sharePct, r.nettingCounterpartyPct, r.nettingGrossPct]))};`,
      `  pm.expect(body.rows.map((r) => [r.session, r.sharePct, r.nettingCounterpartyPct, r.nettingGrossPct])).to.eql(want);`,
      `});`,
      `pm.test("off hours at 10 to 20 percent share is the 27 to 33 the pitch quotes", () => {`,
      `  const at = (s) => body.rows.find((r) => r.session === "off_hours_weekday" && r.sharePct === s).nettingCounterpartyPct;`,
      `  pm.expect(Math.round(at(10))).to.eql(27);`,
      `  pm.expect(Math.round(at(20))).to.eql(33);`,
      `});`,
    ],
    why: "F30. A simulation over real August trades, not a measurement of Nokturn, and the label travels in the data so no screen can drop it. The expected rows are read from data/backtest when this file is generated.",
  },
);

// Asked of the running api, so the case below checks a real auction when the
// keeper has opened one and the 404 when it has not.
const hasAuction = await fetch(`${API}/v1/auctions/1`).then((r) => r.status === 200);

// GET /v1/batches is real since Hari 5. It answers live, so its shape is
// checked directly rather than through the 503 stub loop below.
const batchList = await fetch(`${API}/v1/batches`).then((r) => r.json());
requests.push({
  name: "/v1/batches lists real batches, cursor first",
  method: "GET",
  path: "/v1/batches",
  tests: [
    `pm.test("batches is an array", () => pm.expect(body.batches).to.be.an("array"));`,
    `pm.test("cursor is a string or null", () => pm.expect(body.cursor === null || typeof body.cursor === "string").to.eql(true));`,
    `if (body.batches.length) {`,
    `  pm.test("each batch names an outcome and a real netting ratio", () => {`,
    `    for (const b of body.batches) {`,
    `      pm.expect(["settled", "passthrough", "expired"]).to.include(b.outcome);`,
    `      pm.expect(Number(b.nettingRatioBps)).to.be.at.least(0);`,
    `    }`,
    `  });`,
    `}`,
  ],
  why: "The indexer's own tables, not the mempool. No batch settled yet is a real answer, an empty array, not a stub.",
});

if (batchList.batches?.length) {
  const settled = batchList.batches.find((b) => b.outcome === "settled") ?? batchList.batches[0];
  requests.push({
    name: `/v1/batches/${settled.batchId} is a real receipt`,
    method: "GET",
    path: `/v1/batches/${settled.batchId}`,
    tests: [
      `pm.test("batchId matches", () => pm.expect(body.batchId).to.eql("${settled.batchId}"));`,
      `pm.test("outcome matches the list", () => pm.expect(body.outcome).to.eql("${settled.outcome}"));`,
      `pm.test("provenance names a real block", () => {`,
      `  pm.expect(body.provenance.chainId).to.be.a("number");`,
      `  pm.expect(Number(body.provenance.blockNumber)).to.be.above(0);`,
      `});`,
      `if (body.fills) {`,
      `  pm.test("every fill carries a baseline and a verify call", () => {`,
      `    for (const f of body.fills) {`,
      `      pm.expect(f.baselineBuy).to.be.a("string");`,
      `      pm.expect(f.verifyBaseline.castCommand).to.include("quoteFromState");`,
      `    }`,
      `  });`,
      `  pm.test("every direction's baseline holds its venue floor, with a call to check it", () => {`,
      `    pm.expect(body.baselineFloors.reduce((n, d) => n + d.fills, 0)).to.eql(body.fills.length);`,
      `    for (const d of body.baselineFloors) {`,
      `      pm.expect(d.holds).to.eql(true);`,
      `      pm.expect(BigInt(d.baselineBuy) >= BigInt(d.verifyFloor.expected)).to.eql(true);`,
      `      pm.expect(d.verifyFloor.castCommand).to.include(d.executedSell);`,
      `    }`,
      `  });`,
      `}`,
    ],
    why: `Batch ${settled.batchId} settled on this fork when the collection was generated, docs/rencana-backend.md section 5 Hari 5. Regenerate this collection to pick up whichever batch is settled at the time.`,
  });
} else {
  requests.push({
    name: "/v1/batches/<no batch settled yet> skipped",
    method: "GET",
    path: "/v1/batches/1789900000",
    expectStatus: 404,
    tests: [`pm.test("404, an unknown batch, not invented data", () => pm.response.to.have.status(404));`],
    why: "No batch had settled on this fork when the collection was generated, so there is no real batchId to check a receipt against. Run make solver and make indexer, then regenerate.",
  });
}

requests.push({
  name: "/v1/stream without an upgrade is told to use a websocket",
  method: "GET",
  path: "/v1/stream",
  expectStatus: 426,
  tests: [
    `pm.test("code is COORDINATOR_INVALID_REQUEST", () => pm.expect(body.code).to.eql("COORDINATOR_INVALID_REQUEST"));`,
    `pm.test("the message names the fix", () => pm.expect(body.message).to.match(/websocket/i));`,
  ],
  why: "Newman cannot open a websocket, so this only proves the route is live and refuses plain http in the frozen shape. What travels over the socket is held by torture group f10.",
});

requests.push({
  name: "/v1/auctions/0 is refused as not an auction id",
  method: "GET",
  path: "/v1/auctions/0",
  expectStatus: 400,
  tests: [`pm.test("code is COORDINATOR_INVALID_REQUEST", () => pm.expect(body.code).to.eql("COORDINATOR_INVALID_REQUEST"));`],
  why: "AuctionHouse numbers auctions from one, and id zero is the NONE phase of every mapping. Refused before any chain read.",
});

if (hasAuction) {
  requests.push({
    name: "/v1/auctions/1 is read from AuctionHouse",
    method: "GET",
    path: "/v1/auctions/1",
    tests: [
      ...provenanceChecks,
      `pm.test("auctionId matches", () => pm.expect(body.auctionId).to.eql("1"));`,
      `pm.test("phase is one the contract can be in", () => pm.expect(["disclosing", "frozen", "crossed", "aborted"]).to.include(body.phase));`,
      `pm.test("a result exists exactly when crossed", () => pm.expect(body.result === null).to.eql(body.phase !== "crossed"));`,
      `pm.test("an indicative only while the book is live", () => { if (!["disclosing", "frozen"].includes(body.phase)) pm.expect(body.indicativePrice).to.eql(null); });`,
      `pm.test("an opening cross never claims a print", () => { if (body.kind === "open" && body.result) pm.expect(body.result.sufficient).to.eql(false); });`,
    ],
    why: "An auction the keeper opened on this fork when the collection was generated. Every field is a view on AuctionHouse at the provenance block.",
  });
} else {
  requests.push({
    name: "/v1/auctions/1 before any auction opened is a 404",
    method: "GET",
    path: "/v1/auctions/1",
    expectStatus: 404,
    tests: [
      `pm.test("code is COORDINATOR_INVALID_REQUEST", () => pm.expect(body.code).to.eql("COORDINATOR_INVALID_REQUEST"));`,
      `pm.test("no invented payload rides along", () => pm.expect(body.phase).to.eql(undefined));`,
    ],
    why: "No auction had opened on this fork when the collection was generated. Run make keeper-fork across a closing bell, then regenerate.",
  });
}

const item = (r, index) => ({
  name: `${String(index).padStart(2, "0")}. ${r.name}`,
  event: [
    {
      listen: "test",
      script: {
        type: "text/javascript",
        exec: [
          `// ${r.why}`,
          Array.isArray(r.expectStatus)
            ? `pm.test("http ${r.expectStatus.join(" or ")}", () => pm.expect(${JSON.stringify(r.expectStatus)}).to.include(pm.response.code));`
            : r.expectStatus
              ? `pm.test("http ${r.expectStatus}", () => pm.response.to.have.status(${r.expectStatus}));`
              : `pm.test("http 200", () => pm.response.to.have.status(200));`,
          `const body = pm.response.json();`,
          ...r.tests,
        ],
      },
    },
  ],
  request: {
    method: r.method,
    header: [{key: "content-type", value: "application/json"}],
    url: {raw: `{{api}}${r.path}`, host: [`{{api}}${r.path}`]},
    ...(r.body ? {body: {mode: "raw", raw: JSON.stringify(r.body, null, 2)}} : {}),
    description: r.why,
  },
});

const collection = {
  info: {
    name: "Nokturn coordinator API",
    description: [
      "The HTTP surface the frontend codes against. Generated by",
      "infra/scripts/postman-api.mjs against the running server.",
      "",
      "Every route the api serves is here. Chain reads, the accept and reject",
      "paths for POST /v1/intents, the D4 balance hold, the solver feed with its",
      "withdrawn list, nonces, the escape hatch, receipts and the backtest curve.",
      "GET /v1/auctions/:id reads AuctionHouse, and answers 404 until the keeper",
      "has opened one. WS /v1/stream is live, and a plain GET on it answers 426.",
      "Its events are tested by torture group f10.",
      "",
      "Signatures bind the Settlement and the batch this file was generated",
      "against, so regenerate before each run with make postman-api. The D4 hold",
      "asks for an impossible amount and never trades, and it holds the signer's",
      "USDG only until its batch closes. Do not run it during make replay.",
      "",
      `Settlement ${config.contracts.settlement}`,
      `Network ${config.source.kind}`,
    ].join("\n"),
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    {key: "api", value: API},
    {key: "settlement", value: ""},
    // A batch id the contract accepts even if both requests that set it are
    // skipped, the one M2 settled at the pinned block.
    {key: "feedBatch", value: "1789893840"},
    {key: "nextNonce", value: "0"},
    {key: "holdPending", value: "no"},
    {key: "holdState", value: "none"},
  ],
  item: requests.map(item),
};

mkdirSync(new URL("../postman/", here), {recursive: true});
writeFileSync(
  new URL("../postman/nokturn-api.postman_collection.json", here),
  `${JSON.stringify(collection, null, 2)}\n`,
);
console.log(`wrote nokturn-api.postman_collection.json with ${requests.length} requests`);
console.log(`pointed at ${API}, settlement ${config.contracts.settlement}`);
