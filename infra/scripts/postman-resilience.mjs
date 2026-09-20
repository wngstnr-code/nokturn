// Generates a second Postman collection, the one that tries to break the fork
// rather than confirm it works.
//
// Every scenario in it was found by probing the running fork on 20 September
// 2026, and each request carries the finding it reproduces. Unlike the chain
// checks collection, this one MUTATES the fork clock, so it opens with
// evm_snapshot and closes with evm_revert. Run it deliberately, not in a loop.
//
// The session transition timestamp is queried at generation time and baked in,
// because it comes from the committed NYSE calendar and baking it keeps the
// Postman side free of pre request gymnastics.

import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {createPublicClient, http, encodeFunctionData, toFunctionSelector} from "viem";

const RPC = process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545";
const here = new URL(".", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, here), "utf8"));

const deployment = read("../fork-deployment.json");

const client = createPublicClient({
  chain: {
    id: 4663,
    name: "fork",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [RPC]}},
  },
  transport: http(RPC),
});

const fn = (name, inputs, outputs) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs: inputs.map((type, i) => ({name: `a${i}`, type})),
  outputs: outputs.map((type) => ({type})),
});
const call = (abi, functionName, args = []) => encodeFunctionData({abi: [abi], functionName, args});

const SESSION_AT = fn("sessionAt", ["uint64"], ["uint8"]);
const CURRENT_SESSION = fn("currentSession", [], ["uint8"]);
const BATCH_DURATION = fn("batchDuration", ["uint8"], ["uint32"]);
const IN_GUARD_BAND = fn("inGuardBand", ["uint64"], ["bool"]);
const NEXT_TRANSITION = fn("nextTransition", ["uint64"], ["uint64"]);
const BATCH_WINDOW = fn("batchWindow", ["uint64"], ["uint64", "uint64", "uint64"]);

const MISALIGNED = toFunctionSelector("BatchMisaligned(uint64,uint32)").slice(2);
const IN_BAND = toFunctionSelector("BatchInGuardBand(uint64)").slice(2);

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

const now = Number((await client.getBlock()).timestamp);
const transition = Number(
  await client.readContract({
    address: deployment.sessions,
    abi: [NEXT_TRANSITION],
    functionName: "nextTransition",
    args: [BigInt(now)],
  }),
);
const sessionAfter = await client.readContract({
  address: deployment.sessions,
  abi: [SESSION_AT],
  functionName: "sessionAt",
  args: [BigInt(transition + 300)],
});
const durationAfter = await client.readContract({
  address: deployment.sessions,
  abi: [BATCH_DURATION],
  functionName: "batchDuration",
  args: [sessionAfter],
});

const bothValid = (60 * durationAfter) / gcd(60, durationAfter);

const hex = (n) => `0x${n.toString(16)}`;
const rpcBody = (method, params) => ({jsonrpc: "2.0", id: 1, method, params});
const ethCall = (to, data) => rpcBody("eth_call", [{to, data}, "latest"]);

// The old style batchId a coordinator would keep producing after the session
// changed under it. Picked so it is a multiple of 60 and not of the new duration.
let staleBatchId = Math.floor((transition + 300) / 60) * 60;
while (staleBatchId % durationAfter === 0) staleBatchId -= 60;

const guardBandBatchId = Math.floor((transition - 30) / 60) * 60;
const afterBandBatchId = Math.floor((transition + 60) / durationAfter) * durationAfter;

const requests = [
  {
    name: "snapshot, so nothing here is permanent",
    body: rpcBody("evm_snapshot", []),
    test: [
      `const id = pm.response.json().result;`,
      `pm.collectionVariables.set("snapId", id);`,
      `pm.test("snapshot taken", () => pm.expect(id).to.match(/^0x[0-9a-f]+$/));`,
    ],
    why: "Every later request moves the fork clock. This is how it gets put back.",
  },
  {
    name: "R1. the fork clock is behind the laptop clock",
    body: rpcBody("eth_getBlockByNumber", ["latest", false]),
    test: [
      `const chainTs = parseInt(pm.response.json().result.timestamp, 16);`,
      `const wallTs = Math.floor(Date.now() / 1000);`,
      `const drift = wallTs - chainTs;`,
      `console.log("drift", drift, "seconds, which is", (drift / 3600).toFixed(2), "hours");`,
      `pm.collectionVariables.set("chainTs", String(chainTs));`,
      `pm.test("a batchId from Date.now() is not the batchId from chain time", () => {`,
      `  const fromWall = Math.floor(wallTs / 60) * 60;`,
      `  const fromChain = Math.floor(chainTs / 60) * 60;`,
      `  pm.expect(fromWall).to.not.eql(fromChain, "no drift at this instant, so the trap is hidden. it returns the longer anvil runs");`,
      `});`,
    ],
    why: "The fork starts at the pinned block's timestamp, which is already hours old, and the gap grows with every anvil restart. Code that computes batchId from Date.now() gets SolutionWindowClosed forever, and nothing in that error names the clock.",
  },
  {
    name: "R4a. arm the clock 30s before a session transition",
    body: rpcBody("evm_setNextBlockTimestamp", [hex(transition - 30)]),
    test: [`pm.test("accepted", () => pm.expect(pm.response.json().error).to.eql(undefined));`],
    why: `The transition sits at ${transition}, ${new Date(transition * 1000).toISOString()}.`,
  },
  {
    name: "R4b. mine, so the clock actually moves",
    body: rpcBody("evm_mine", []),
    test: [`pm.test("mined", () => pm.expect(pm.response.json().error).to.eql(undefined));`],
    why: "setNextBlockTimestamp only arms the next block. Without a mine nothing has moved.",
  },
  {
    name: "R4c. inGuardBand is true there",
    body: ethCall(deployment.sessions, call(IN_GUARD_BAND, "inGuardBand", [BigInt(transition - 30)])),
    test: [`pm.test("inside the band", () => pm.expect(parseInt(pm.response.json().result, 16)).to.eql(1));`],
    why: "The band is 60 seconds either side of a boundary, absorbing sequencer clock drift.",
  },
  {
    name: "R4d. batchWindow refuses, BatchInGuardBand",
    body: ethCall(deployment.settlement, call(BATCH_WINDOW, "batchWindow", [BigInt(guardBandBatchId)])),
    test: [
      `const err = pm.response.json().error;`,
      `pm.test("reverted", () => pm.expect(err, "expected a revert").to.not.eql(undefined));`,
      `pm.test("with BatchInGuardBand", () => pm.expect(JSON.stringify(err)).to.include("${IN_BAND}"));`,
    ],
    why: "No batch exists across a transition. That is not an outage, it is the guard band working.",
  },
  {
    name: "R4e. THE TRAP. 60s after the transition inGuardBand says false",
    body: ethCall(deployment.sessions, call(IN_GUARD_BAND, "inGuardBand", [BigInt(transition + 60)])),
    test: [
      `pm.test("the wall clock says you are clear", () => pm.expect(parseInt(pm.response.json().result, 16)).to.eql(0));`,
    ],
    why: "A coordinator asking inGuardBand(now) would conclude it is safe to open a batch here.",
  },
  {
    name: "R4f. but batchWindow still refuses, because it asks about the batchId",
    body: ethCall(deployment.settlement, call(BATCH_WINDOW, "batchWindow", [BigInt(afterBandBatchId)])),
    test: [
      `const err = pm.response.json().error;`,
      `pm.test("still reverts", () => pm.expect(err, "expected a revert").to.not.eql(undefined));`,
      `pm.test("BatchInGuardBand again", () => pm.expect(JSON.stringify(err)).to.include("${IN_BAND}"));`,
    ],
    why: "batchWindow checks inGuardBand(batchId), and the aligned batchId lands back inside the band. Always test the batchId, never the wall clock.",
  },
  {
    name: "R5a. arm the clock past the transition",
    body: rpcBody("evm_setNextBlockTimestamp", [hex(transition + 300)]),
    test: [`pm.test("accepted", () => pm.expect(pm.response.json().error).to.eql(undefined));`],
    why: "Far enough out that the band is behind us and the new session is fully in force.",
  },
  {
    name: "R5b. mine",
    body: rpcBody("evm_mine", []),
    test: [`pm.test("mined", () => pm.expect(pm.response.json().error).to.eql(undefined));`],
    why: "",
  },
  {
    name: "R5c. the session changed under us",
    body: ethCall(deployment.sessions, call(CURRENT_SESSION, "currentSession")),
    test: [
      `const s = parseInt(pm.response.json().result, 16);`,
      `console.log("session is now", s);`,
      `pm.test("no longer CLOSED_WEEKEND", () => pm.expect(s).to.not.eql(6));`,
    ],
    why: `The calendar moves the chain out of CLOSED_WEEKEND into session ${sessionAfter}.`,
  },
  {
    name: "R5d. batch duration changed, so every cached batchId is suspect",
    body: ethCall(deployment.sessions, call(BATCH_DURATION, "batchDuration", [sessionAfter])),
    test: [
      `const d = parseInt(pm.response.json().result, 16);`,
      `pm.test("duration is ${durationAfter}, not 60", () => pm.expect(d).to.eql(${durationAfter}));`,
      `console.log("only batchIds divisible by ${bothValid} are valid in both sessions");`,
    ],
    why: `A coordinator holding duration=60 keeps emitting multiples of 60. Only multiples of ${bothValid} are also valid here, so most of them revert.`,
  },
  {
    name: "R5e. an old 60 aligned batchId now reverts BatchMisaligned",
    body: ethCall(deployment.settlement, call(BATCH_WINDOW, "batchWindow", [BigInt(staleBatchId)])),
    test: [
      `const err = pm.response.json().error;`,
      `pm.test("reverted", () => pm.expect(err, "expected a revert").to.not.eql(undefined));`,
      `pm.test("with BatchMisaligned", () => pm.expect(JSON.stringify(err)).to.include("${MISALIGNED}"));`,
    ],
    why: "This is the failure a coordinator hits on every batch after a session boundary if it caches the duration.",
  },
  {
    name: "revert, put the fork back where it was",
    revert: true,
    test: [`pm.test("reverted", () => pm.expect(pm.response.json().result).to.eql(true));`],
    why: "Without this the fork stays hours in the future and every later test is wrong.",
  },
  {
    name: "and the session is CLOSED_WEEKEND again",
    body: ethCall(deployment.sessions, call(CURRENT_SESSION, "currentSession")),
    test: [`pm.test("back to 6", () => pm.expect(parseInt(pm.response.json().result, 16)).to.eql(6));`],
    why: "Proves evm_revert restores the clock, not only the balances.",
  },
];

const item = (r, index) => ({
  name: `${String(index).padStart(2, "0")}. ${r.name}`,
  event: [
    {
      listen: "test",
      script: {
        type: "text/javascript",
        exec: [
          r.why ? `// ${r.why}` : "",
          `pm.test("http 200", () => pm.response.to.have.status(200));`,
          ...r.test,
        ].filter(Boolean),
      },
    },
  ],
  request: {
    method: "POST",
    header: [{key: "content-type", value: "application/json"}],
    url: {raw: "{{rpc}}", host: ["{{rpc}}"]},
    body: {
      mode: "raw",
      raw: r.revert
        ? '{\n  "jsonrpc": "2.0",\n  "id": 1,\n  "method": "evm_revert",\n  "params": ["{{snapId}}"]\n}'
        : JSON.stringify(r.body, null, 2),
      options: {raw: {language: "json"}},
    },
    description: r.why,
  },
});

const collection = {
  info: {
    name: "Nokturn fork, resilience",
    description: [
      "Tries to break the fork rather than confirm it works. Generated by",
      "infra/scripts/postman-resilience.mjs against the live deployment.",
      "",
      "THIS COLLECTION MOVES THE FORK CLOCK. It opens with evm_snapshot and closes",
      "with evm_revert. If a run is interrupted partway, run `make revert` before",
      "trusting anything else the fork says.",
      "",
      `Transition baked in at ${transition}, ${new Date(transition * 1000).toISOString()}`,
      `Session after it: ${sessionAfter}, batch duration ${durationAfter}s`,
      `Only batchIds divisible by ${bothValid} are valid on both sides of it.`,
    ].join("\n"),
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    {key: "rpc", value: RPC},
    {key: "snapId", value: ""},
    {key: "chainTs", value: ""},
  ],
  item: requests.map(item),
};

mkdirSync(new URL("../postman/", here), {recursive: true});
writeFileSync(
  new URL("../postman/nokturn-resilience.postman_collection.json", here),
  `${JSON.stringify(collection, null, 2)}\n`,
);
console.log(`wrote nokturn-resilience.postman_collection.json with ${requests.length} requests`);
console.log(`transition ${transition}, session after ${sessionAfter}, duration ${durationAfter}s`);
console.log(`batchIds valid on both sides must divide by ${bothValid}`);
