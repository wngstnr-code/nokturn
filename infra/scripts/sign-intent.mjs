// Signs one Intent with a demo user's key and submits it to the running
// coordinator. Exists so POST /v1/intents can be exercised without a
// frontend, and exports buildSignedIntent so postman-api.mjs can generate a
// request body with a real signature instead of a canned one.
//
// The digest comes from api/src/permit2.ts, the same module the API verifies
// a submission against, so there is no third definition of the encoding to
// drift from the other two.
//
// Run with no arguments for the happy path. Run with --case nonce-used or
// --case no-approve to reproduce the two negative cases that need to change
// fork state first. Both refuse to run against anything that does not answer
// anvil_nodeInfo, because both leave the fork in a different state.

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createWalletClient, http, isHex, maxUint256, parseUnits} from "viem";
import {mnemonicToAccount} from "viem/accounts";
import {decodeIntent, witnessDigest} from "../../api/src/permit2.ts";
import {chain, initChain, permit2Abi, read, settlementAbi} from "../../api/src/chain.ts";

const API = process.env.NOKTURN_API_URL ?? "http://127.0.0.1:3000";
const RPC = process.env.NOKTURN_FORK_RPC ?? "http://127.0.0.1:8545";
const here = new URL(".", import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, here), "utf8"));
const accounts = readJson("../accounts.json");

/** infra/accounts.json note. Anvil's own default keys carry an EIP-7702
 * delegation on the real chain, so this project signs with its own throwaway
 * mnemonic instead. */
const MNEMONIC =
  process.env.NOKTURN_FORK_MNEMONIC ??
  "spin skill strategy deal rebel image eager original crowd baby inhale calm";
/** infra/accounts.json calls this one user0, check-permit2.mjs derives it the
 * same way. The other three users are not written down anywhere as indices,
 * so they are derived and checked against accounts.json below rather than
 * assumed. */
const USER_INDEX_BASE = 6;

process.env.NOKTURN_API_RPC = RPC;
await initChain();
const c = chain();

const userAccounts = accounts.users.map((expected, i) => {
  const index = USER_INDEX_BASE + i;
  const derived = mnemonicToAccount(MNEMONIC, {addressIndex: index});
  if (derived.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `mnemonic index ${index} derives ${derived.address}, expected users[${i}] ${expected} from accounts.json. ` +
        "the index scheme changed, fix USER_INDEX_BASE rather than guessing",
    );
  }
  return derived;
});
const user0 = userAccounts[0];

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      {name: "spender", type: "address"},
      {name: "amount", type: "uint256"},
    ],
    outputs: [{type: "bool"}],
  },
];

async function assertIsEoa(address) {
  const code = await c.client.getCode({address});
  if (code && code !== "0x") {
    throw new Error(`${address} carries code, refusing to sign with it. docs/rencana-backend.md section 3C`);
  }
}

async function requireFork() {
  try {
    await c.client.transport.request({method: "anvil_nodeInfo", params: []});
  } catch {
    throw new Error("this case mutates fork state and only runs against a fork, anvil_nodeInfo failed");
  }
}

async function fetchJson(path, init) {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json();
  return {status: res.status, body};
}

/**
 * Builds and signs one Intent, ready to POST to /v1/intents.
 *
 * overrides.account picks the signer, default user0. overrides.fields is
 * merged into the payload before the digest is computed, which is how a
 * negative case gets a validly signed intent for a disallowed token instead
 * of a signature that fails for the wrong reason. overrides.signature skips
 * signing altogether, for the case that needs a signature that is simply
 * wrong.
 */
export async function buildSignedIntent(overrides = {}) {
  const owner = overrides.account ?? user0;
  await assertIsEoa(owner.address);

  const nonceInfo = await fetchJson(`/v1/nonces/${owner.address}`);
  if (nonceInfo.status !== 200) {
    throw new Error(`GET /v1/nonces/${owner.address} answered ${nonceInfo.status}: ${JSON.stringify(nonceInfo.body)}`);
  }
  const windowRes = await fetchJson("/v1/batches/current");
  if (windowRes.status !== 200 || windowRes.body.batchId === null) {
    throw new Error(`no open batch to build an intent for: ${JSON.stringify(windowRes.body)}`);
  }
  const window = windowRes.body;

  const nvda = c.tokens.find((t) => t.symbol === "NVDA");
  const now = Number((await c.client.getBlock()).timestamp);
  const sellAmount = overrides.sellAmount ?? parseUnits("50", c.quote.decimals);

  const payload = {
    owner: owner.address,
    receiver: owner.address,
    sellToken: c.quote.address,
    buyToken: nvda.token,
    sellAmount: String(sellAmount),
    minBuyAmount: "1",
    validAfter: String(now - 60),
    validUntil: String(Number(window.collectEndsAt) + 3600),
    flags: "1",
    kind: "0",
    maxDevFromRefBps: "0",
    allowedSessions: String(1 << Number(window.session)),
    batchSpan: "1",
    nonce: nonceInfo.body.next,
    ...overrides.fields,
  };

  const intent = decodeIntent(payload);
  const [domainSeparator, witnessTypeString] = await Promise.all([
    read(c.permit2, permit2Abi, "DOMAIN_SEPARATOR"),
    read(c.deployment.settlement, settlementAbi, "WITNESS_TYPE_STRING"),
  ]);
  const digest = witnessDigest({domainSeparator, witnessTypeString, intent, spender: c.deployment.settlement});
  const signature = overrides.signature ?? (await owner.sign({hash: digest}));
  if (!isHex(signature)) throw new Error("signature must be hex");

  return {intent: payload, signature, digest, owner: owner.address};
}

async function submit(built) {
  return fetchJson("/v1/intents", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({intent: built.intent, signature: built.signature}),
  });
}

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log(`  ok    ${m}`);
};
const bad = (m) => {
  fail += 1;
  console.log(`  FAIL  ${m}`);
};

async function happyPath() {
  const built = await buildSignedIntent();
  const {status, body} = await submit(built);
  if (status === 200) {
    console.log(`submitted, batchId ${body.batchId}, status ${body.status}`);
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log(`FAIL  ${status} ${body.code}: ${body.message}`);
    process.exitCode = 1;
  }
}

/** Invalidates the nonce a fresh intent would use, then submits with it anyway. */
async function caseNonceUsed() {
  await requireFork();
  const wallet = createWalletClient({account: user0, chain: c.client.chain, transport: http(RPC)});

  const nonceInfo = await fetchJson(`/v1/nonces/${user0.address}`);
  const nonce = BigInt(nonceInfo.body.next);
  const word = nonce >> 8n;
  const mask = 1n << (nonce % 256n);

  const hash = await wallet.writeContract({
    address: c.permit2,
    abi: permit2Abi,
    functionName: "invalidateUnorderedNonces",
    args: [word, mask],
  });
  await c.client.waitForTransactionReceipt({hash});

  const built = await buildSignedIntent({fields: {nonce: String(nonce)}});
  const {status, body} = await submit(built);
  if (status === 409 && body.code === "NonceAlreadyUsed") {
    ok(`nonce-used got NonceAlreadyUsed for nonce ${nonce}`);
  } else {
    bad(`nonce-used got ${status} ${body.code ?? "?"}: ${body.message ?? ""}`);
  }
}

/** Drops one user's Permit2 allowance to zero, submits, then restores it. */
async function caseNoApprove() {
  await requireFork();
  const lastUser = userAccounts[userAccounts.length - 1];
  const wallet = createWalletClient({account: lastUser, chain: c.client.chain, transport: http(RPC)});

  const drop = await wallet.writeContract({
    address: c.quote.address,
    abi: erc20ApproveAbi,
    functionName: "approve",
    args: [c.permit2, 0n],
  });
  await c.client.waitForTransactionReceipt({hash: drop});

  try {
    const built = await buildSignedIntent({account: lastUser});
    const {status, body} = await submit(built);
    if (status === 400 && body.code === "COORDINATOR_PERMIT2_NOT_APPROVED") {
      ok(`no-approve got COORDINATOR_PERMIT2_NOT_APPROVED for ${lastUser.address}`);
    } else {
      bad(`no-approve got ${status} ${body.code ?? "?"}: ${body.message ?? ""}`);
    }
  } finally {
    const restore = await wallet.writeContract({
      address: c.quote.address,
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [c.permit2, maxUint256],
    });
    await c.client.waitForTransactionReceipt({hash: restore});
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const caseIndex = args.indexOf("--case");
  const caseName = caseIndex >= 0 ? args[caseIndex + 1] : null;

  if (caseName === "nonce-used") await caseNonceUsed();
  else if (caseName === "no-approve") await caseNoApprove();
  else if (caseName) {
    bad(`unknown case ${caseName}, expected nonce-used or no-approve`);
  } else {
    await happyPath();
  }

  if (fail > 0) {
    console.log(`\n${pass} pass, ${fail} fail`);
    process.exitCode = 1;
  }
}
