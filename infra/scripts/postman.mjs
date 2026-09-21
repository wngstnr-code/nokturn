// Generates a Postman collection that exercises the fork over plain JSON-RPC.
//
// Generated rather than committed by hand, because the Settlement address is
// different after every `make deploy` and a collection with a stale address
// fails in a way that looks like a broken chain.
//
// What this proves is the whole of target one. If every request here is green,
// the fork is up, the protocol is deployed, the calendar and the feeds are
// loaded, the allowlist is set, the baseline quotes, and the demo accounts can
// actually spend. The coordinator endpoints in packages/shared/api-types.ts get
// their own collection once the server exists on day two.

import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {encodeFunctionData, parseUnits, toHex} from "viem";

const here = new URL(".", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, here), "utf8"));

const chain = read("../chain.json");
const accounts = read("../accounts.json");
const deployment = read("../fork-deployment.json");
const pin = read("../pinned-block.json");

const fn = (name, inputs, outputs, stateMutability = "view") => ({
  type: "function",
  name,
  stateMutability,
  inputs: inputs.map((type, i) => ({name: `a${i}`, type})),
  outputs: outputs.map((type) => ({type})),
});

const call = (abi, functionName, args = []) => encodeFunctionData({abi: [abi], functionName, args});

const NVDA = chain.tokens.NVDA;

// Each entry is one request. `expect` is a Postman test written as a string,
// evaluated with `result` bound to the decoded hex string from the response.
const requests = [
  {
    name: "chain id is 4663",
    method: "eth_chainId",
    params: [],
    expect: `pm.expect(parseInt(result, 16)).to.eql(4663);`,
    why: "A fork on any other chain id cannot run SetFeeds, so it cannot settle.",
  },
  {
    name: "block number is past the pinned block",
    method: "eth_blockNumber",
    params: [],
    expect: `pm.expect(parseInt(result, 16)).to.be.above(${pin.block});`,
    why: "Proves the fork started from the pinned block and time is moving.",
  },
  {
    name: "settlement is deployed",
    method: "eth_getCode",
    params: [deployment.settlement, "latest"],
    expect: `pm.expect(result.length).to.be.above(2);`,
    why: "An empty code answer means make deploy did not run against this fork.",
  },
  {
    name: "session is a real session",
    method: "eth_call",
    params: [{to: deployment.sessions, data: call(fn("currentSession", [], ["uint8"]), "currentSession")}, "latest"],
    expect: `pm.expect(parseInt(result, 16)).to.be.within(0, 8);`,
    why: "6 is CLOSED_WEEKEND, 3 is OPEN. See Session in packages/shared/types.ts.",
  },
  {
    name: "weekend batches are 60 seconds",
    method: "eth_call",
    params: [
      {to: deployment.sessions, data: call(fn("batchDuration", ["uint8"], ["uint32"]), "batchDuration", [6])},
      "latest",
    ],
    expect: `pm.expect(parseInt(result, 16)).to.eql(60);`,
    why: "parameter.md section 1, BATCH_WEEKEND. A 0 here means an auction phase.",
  },
  {
    name: "weekend band is 150 bps",
    method: "eth_call",
    params: [
      {to: deployment.sessions, data: call(fn("maxDeviationBps", ["uint8"], ["uint16"]), "maxDeviationBps", [6])},
      "latest",
    ],
    expect: `pm.expect(parseInt(result, 16)).to.eql(150);`,
    why: "parameter.md section 2.",
  },
  {
    name: "NVDA is on the allowlist",
    method: "eth_call",
    params: [
      {to: deployment.settlement, data: call(fn("tokenAllowed", ["address"], ["bool"]), "tokenAllowed", [NVDA.token])},
      "latest",
    ],
    expect: `pm.expect(parseInt(result, 16)).to.eql(1);`,
    why: "Set by Bootstrap, and only after the beacon and multiplier gate passed.",
  },
  {
    name: "baseline adapter is set",
    method: "eth_call",
    params: [
      {to: deployment.settlement, data: call(fn("baselineAdapter", [], ["address"]), "baselineAdapter")},
      "latest",
    ],
    expect: `pm.expect(result.toLowerCase()).to.include("${deployment.adapter.slice(2).toLowerCase()}");`,
    why: "Unset means every batch is forced to pass through with zero savings. parameter.md 4C.",
  },
  {
    name: "cap per batch is 5000 USD",
    method: "eth_call",
    params: [
      {to: deployment.settlement, data: call(fn("capPerBatchUsd", [], ["uint256"]), "capPerBatchUsd")},
      "latest",
    ],
    expect: `pm.expect(BigInt(result)).to.eql(5000000000000000000000n);`,
    why: "parameter.md section 6. Halved again on weekends inside the contract.",
  },
  {
    name: "oracle prices NVDA and says healthy",
    method: "eth_call",
    params: [
      {
        to: deployment.oracle,
        data: call(fn("refPrice", ["address"], ["uint256", "uint64", "bool"]), "refPrice", [NVDA.token]),
      },
      "latest",
    ],
    expect: [
      `const price = BigInt("0x" + result.slice(2, 66));`,
      `const healthy = BigInt("0x" + result.slice(130, 194));`,
      `pm.expect(healthy).to.eql(1n, "oracle unhealthy, every solution would revert with OracleUnhealthy");`,
      `pm.expect(Number(price / 10n ** 16n) / 100).to.be.within(1, 100000);`,
    ].join("\n"),
    why: "An unhealthy oracle is the single most common reason a batch cannot settle.",
  },
  {
    name: "baseline quotes 1000 USDG into NVDA",
    method: "eth_call",
    params: [
      {
        to: deployment.adapter,
        data: call(fn("quoteFromState", ["address", "address", "uint256"], ["uint256"]), "quoteFromState", [
          chain.usdg,
          NVDA.token,
          parseUnits("1000", chain.usdgDecimals),
        ]),
      },
      "latest",
    ],
    expect: [
      `pm.expect(result).to.not.eql("0x", "the adapter reverted, so there is no baseline");`,
      `pm.expect(BigInt(result) > 0n).to.eql(true);`,
      `pm.collectionVariables.set("baselineNvda", BigInt(result).toString());`,
    ].join("\n"),
    why: "This is the number every savings claim is measured against.",
  },
  {
    name: "baseline is monotonic in size",
    method: "eth_call",
    params: [
      {
        to: deployment.adapter,
        data: call(fn("quoteFromState", ["address", "address", "uint256"], ["uint256"]), "quoteFromState", [
          chain.usdg,
          NVDA.token,
          parseUnits("2000", chain.usdgDecimals),
        ]),
      },
      "latest",
    ],
    expect: [
      `const small = BigInt(pm.collectionVariables.get("baselineNvda"));`,
      `const large = BigInt(result);`,
      `pm.expect(large > small).to.eql(true, "twice the input must buy more");`,
      `pm.expect(large < small * 2n).to.eql(true, "and less than twice as much, because of price impact");`,
    ].join("\n"),
    why: "Concavity in size is what makes the per intent baseline clear the aggregate floor.",
  },
  {
    name: "GME baseline refuses at 100k, and that is correct",
    method: "eth_call",
    params: [
      {
        to: deployment.adapter,
        data: call(fn("quoteFromState", ["address", "address", "uint256"], ["uint256"]), "quoteFromState", [
          chain.usdg,
          chain.tokens.GME.token,
          parseUnits("100000", chain.usdgDecimals),
        ]),
      },
      "latest",
    ],
    expectError: true,
    expect: `pm.expect(pm.response.json().error, "expected a revert, the GME pool cannot absorb 100k from state").to.not.eql(undefined);`,
    why: "Fails closed rather than guessing. This is the deterministic pass through case for the failure screen.",
  },
  {
    name: "solver A is bonded and active",
    method: "eth_call",
    params: [
      {
        to: deployment.solvers,
        data: call(fn("isActive", ["address"], ["bool"]), "isActive", [accounts.solverA]),
      },
      "latest",
    ],
    expect: `pm.expect(parseInt(result, 16)).to.eql(1, "run make fund");`,
    why: "submitSolution reverts with SolverNotActive otherwise.",
  },
  {
    name: "user0 holds USDG",
    method: "eth_call",
    params: [
      {
        to: chain.usdg,
        data: call(fn("balanceOf", ["address"], ["uint256"]), "balanceOf", [accounts.users[0]]),
      },
      "latest",
    ],
    expect: `pm.expect(BigInt(result) > 0n).to.eql(true, "run make fund");`,
    why: "Six decimals. 10000 USDG reads as 10000000000.",
  },
  {
    name: "user0 approved Permit2 on NVDA",
    method: "eth_call",
    params: [
      {
        to: NVDA.token,
        data: call(fn("allowance", ["address", "address"], ["uint256"]), "allowance", [
          accounts.users[0],
          chain.permit2,
        ]),
      },
      "latest",
    ],
    expect: `pm.expect(BigInt(result) > 0n).to.eql(true, "without this, finalize reverts when Permit2 pulls");`,
    why: "The signature is only spendable if the token itself has approved Permit2.",
  },
  {
    name: "Permit2 domain separator is bound to this chain",
    method: "eth_call",
    params: [
      {to: chain.permit2, data: call(fn("DOMAIN_SEPARATOR", [], ["bytes32"]), "DOMAIN_SEPARATOR")},
      "latest",
    ],
    expect: [
      `pm.expect(result).to.match(/^0x[0-9a-f]{64}$/);`,
      `pm.collectionVariables.set("permit2Domain", result);`,
    ].join("\n"),
    why: "Read it, never hardcode it. Permit2 rebuilds it when the chain id is not the deploy one.",
  },
  {
    name: "witness type string comes from the contract",
    method: "eth_call",
    params: [
      {
        to: deployment.settlement,
        data: call(fn("WITNESS_TYPE_STRING", [], ["string"]), "WITNESS_TYPE_STRING"),
      },
      "latest",
    ],
    expect: [
      `const hex = result.slice(2 + 128);`,
      `const text = Buffer.from(hex, "hex").toString("utf8").replace(/\\u0000+$/, "");`,
      `pm.expect(text).to.include("Intent witness)Intent(");`,
      `pm.expect(text).to.include("TokenPermissions(address token,uint256 amount)");`,
      `pm.collectionVariables.set("witnessTypeString", text);`,
    ].join("\n"),
    why: "This exact string goes into the Permit2 signature. Copying it by hand is how signatures stop verifying.",
  },
  {
    name: "settlement is not paused",
    method: "eth_call",
    params: [{to: deployment.settlement, data: call(fn("isPaused", [], ["bool"]), "isPaused")}, "latest"],
    expect: `pm.expect(parseInt(result, 16)).to.eql(0);`,
    why: "A paused Settlement accepts no new solutions for six hours.",
  },
];

const item = (r, index) => ({
  name: `${String(index + 1).padStart(2, "0")}. ${r.name}`,
  event: [
    {
      listen: "test",
      script: {
        type: "text/javascript",
        exec: [
          `// ${r.why}`,
          `pm.test("http 200", () => pm.response.to.have.status(200));`,
          r.expectError
            ? r.expect
            : [
                `const body = pm.response.json();`,
                `pm.test("no rpc error", () => pm.expect(body.error, JSON.stringify(body.error)).to.eql(undefined));`,
                `const result = body.result;`,
                `pm.test("${r.name.replace(/"/g, "'")}", () => {`,
                r.expect,
                `});`,
              ].join("\n"),
        ].join("\n"),
      },
    },
  ],
  request: {
    method: "POST",
    header: [{key: "content-type", value: "application/json"}],
    url: {raw: "{{rpc}}", host: ["{{rpc}}"]},
    body: {
      mode: "raw",
      raw: JSON.stringify({jsonrpc: "2.0", id: index + 1, method: r.method, params: r.params}, null, 2),
      options: {raw: {language: "json"}},
    },
    description: r.why,
  },
});

const collection = {
  info: {
    name: "Nokturn fork, chain checks",
    description: [
      "Generated by infra/scripts/postman.mjs against the fork deployment recorded",
      `in infra/fork-deployment.json. Regenerate after every make deploy.`,
      "",
      `Settlement ${deployment.settlement}`,
      `Adapter    ${deployment.adapter}`,
      `Pinned at  ${pin.block} (${pin.timestampUtc})`,
    ].join("\n"),
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    {key: "rpc", value: "http://127.0.0.1:8545"},
    {key: "baselineNvda", value: ""},
    {key: "permit2Domain", value: ""},
    {key: "witnessTypeString", value: ""},
  ],
  item: requests.map(item),
};

const environment = {
  name: "Nokturn local fork",
  values: [
    {key: "rpc", value: "http://127.0.0.1:8545", enabled: true},
    {key: "api", value: "http://127.0.0.1:3000", enabled: true},
    {key: "settlement", value: deployment.settlement, enabled: true},
    {key: "adapter", value: deployment.adapter, enabled: true},
    {key: "oracle", value: deployment.oracle, enabled: true},
    {key: "sessions", value: deployment.sessions, enabled: true},
    {key: "solvers", value: deployment.solvers, enabled: true},
    {key: "usdg", value: chain.usdg, enabled: true},
    {key: "permit2", value: chain.permit2, enabled: true},
    {key: "nvda", value: NVDA.token, enabled: true},
    {key: "nvdaPool", value: NVDA.pool, enabled: true},
    {key: "user0", value: accounts.users[0], enabled: true},
    {key: "solverA", value: accounts.solverA, enabled: true},
    {key: "pinnedBlock", value: String(pin.block), enabled: true},
  ],
  _postman_variable_scope: "environment",
};

mkdirSync(new URL("../postman/", here), {recursive: true});
writeFileSync(
  new URL("../postman/nokturn-fork.postman_collection.json", here),
  `${JSON.stringify(collection, null, 2)}\n`,
);
writeFileSync(
  new URL("../postman/nokturn-local.postman_environment.json", here),
  `${JSON.stringify(environment, null, 2)}\n`,
);

console.log(`wrote infra/postman/ with ${collection.item.length} requests`);
console.log(`settlement ${deployment.settlement}`);
