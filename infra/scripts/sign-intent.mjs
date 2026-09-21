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
// anvil_nodeInfo, both change only a throwaway account, and both run inside an
// evm_snapshot that is reverted on the way out.

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createWalletClient, http, isHex, parseUnits} from "viem";
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

/**
 * Derived from the same mnemonic but outside accounts.json, so no suite relies
 * on it. The two negative cases change its state instead of a demo user's. They
 * used to drop user3's allowance and burn user0's nonce, and a run killed
 * between the change and its finally left the fork broken for every suite that
 * came after. D16 in the torture report.
 */
const THROWAWAY_INDEX = 100;
const throwaway = mnemonicToAccount(MNEMONIC, {addressIndex: THROWAWAY_INDEX});

const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      {name: "to", type: "address"},
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

/** Runs a case inside evm_snapshot, so a normal exit or a throw leaves no trace. */
async function inSnapshot(fn) {
  const rpc = (method, params) => c.client.transport.request({method, params});
  const id = await rpc("evm_snapshot", []);
  try {
    return await fn();
  } finally {
    await rpc("evm_revert", [id]);
  }
}

async function fundGas(address) {
  await c.client.transport.request({method: "anvil_setBalance", params: [address, "0xde0b6b3a7640000"]});
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

/** Burns the throwaway account's next nonce, then submits with it anyway. */
async function caseNonceUsed() {
  await requireFork();
  await inSnapshot(async () => {
    await fundGas(throwaway.address);
    const wallet = createWalletClient({account: throwaway, chain: c.client.chain, transport: http(RPC)});

    const nonceInfo = await fetchJson(`/v1/nonces/${throwaway.address}`);
    const nonce = BigInt(nonceInfo.body.next);
    const hash = await wallet.writeContract({
      address: c.permit2,
      abi: permit2Abi,
      functionName: "invalidateUnorderedNonces",
      args: [nonce >> 8n, 1n << (nonce % 256n)],
    });
    await c.client.waitForTransactionReceipt({hash});
    console.log(`state changed, nonce ${nonce} burned on throwaway ${throwaway.address}`);

    const built = await buildSignedIntent({account: throwaway, fields: {nonce: String(nonce)}});
    const {status, body} = await submit(built);
    if (status === 409 && body.code === "NonceAlreadyUsed") {
      ok(`nonce-used got NonceAlreadyUsed for nonce ${nonce}`);
    } else {
      bad(`nonce-used got ${status} ${body.code ?? "?"}: ${body.message ?? ""}`);
    }
  });
}

/**
 * Funds the throwaway account, which has never approved Permit2, and submits
 * from it. No allowance has to be dropped and put back, because none was ever
 * given.
 */
async function caseNoApprove() {
  await requireFork();
  await inSnapshot(async () => {
    await fundGas(throwaway.address);
    const sellAmount = parseUnits("50", c.quote.decimals);
    const wallet = createWalletClient({account: user0, chain: c.client.chain, transport: http(RPC)});
    const hash = await wallet.writeContract({
      address: c.quote.address,
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [throwaway.address, sellAmount],
    });
    await c.client.waitForTransactionReceipt({hash});
    console.log(`state changed, throwaway ${throwaway.address} funded with ${sellAmount} USDG units`);

    const built = await buildSignedIntent({account: throwaway, sellAmount});
    const {status, body} = await submit(built);
    if (status === 400 && body.code === "COORDINATOR_PERMIT2_NOT_APPROVED") {
      ok(`no-approve got COORDINATOR_PERMIT2_NOT_APPROVED for ${throwaway.address}`);
    } else {
      bad(`no-approve got ${status} ${body.code ?? "?"}: ${body.message ?? ""}`);
    }
  });
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
