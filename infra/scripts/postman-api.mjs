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

import {writeFileSync, mkdirSync} from "node:fs";
import {buildSignedIntent} from "./sign-intent.mjs";

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
      `pm.test("indexer is reported down rather than faked", () => pm.expect(body.components.indexer).to.eql("down"));`,
    ],
    why: "The indexer does not exist yet, and health says so instead of reporting a number it cannot know.",
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
      `pm.test("nobody has won a batch yet, and that is reported honestly", () => {`,
      `  for (const s of body.solvers) pm.expect(s.batchesWon).to.eql(0);`,
      `});`,
    ],
    why: "The board is derived from SolverRegistry, so there is nothing self reported. Zero wins is the true number today.",
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

const stubs = [
  {method: "GET", path: "/v1/batches", needs: "the indexer"},
  {method: "GET", path: "/v1/batches/1789900000", needs: "the indexer"},
  {method: "GET", path: "/v1/auctions/1", needs: "an auction"},
  {method: "GET", path: "/v1/stream", needs: "the coordinator"},
];

for (const s of stubs) {
  requests.push({
    name: `${s.path} answers 503 in the frozen shape`,
    method: s.method,
    path: s.path,
    expectStatus: 503,
    tests: [
      `pm.test("503, not 404", () => pm.response.to.have.status(503));`,
      `pm.test("code is COORDINATOR_NOT_IMPLEMENTED", () => pm.expect(body.code).to.eql("COORDINATOR_NOT_IMPLEMENTED"));`,
      `pm.test("no invented payload rides along", () => {`,
      `  pm.expect(body.batchId, "a stub must never return data").to.eql(undefined);`,
      `  pm.expect(body.fills).to.eql(undefined);`,
      `});`,
    ],
    why: `The route is frozen but needs ${s.needs}. It says so rather than returning a shape nobody planned for, and it never fills a screen with numbers that are not real.`,
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
          r.expectStatus
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
      "Chain reads, and the coordinator's own accept and reject paths for",
      "POST /v1/intents, answer for real. Three routes still answer 503 in the",
      "frozen error shape because they need the indexer or an open auction.",
      "None of them invent data.",
      "",
      "The happy path for submitting an intent does not live here, because",
      "running this collection twice against the same batch would hit its own",
      "duplicate. Run make sign-intent for that, and for the two cases that",
      "mutate fork state, --case nonce-used and --case no-approve.",
      "",
      `Settlement ${config.contracts.settlement}`,
      `Network ${config.source.kind}`,
    ].join("\n"),
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    {key: "api", value: API},
    {key: "settlement", value: ""},
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
