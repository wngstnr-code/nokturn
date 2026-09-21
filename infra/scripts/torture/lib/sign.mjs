// Signers and intent builders for the torture suite.
//
// Every key is derived from the project mnemonic and checked against
// infra/accounts.json, never taken from anvil's defaults, which carry an
// EIP-7702 delegation on the real chain. The digest is the one api/src/permit2.ts
// computes, so the suite signs exactly what the API verifies.
//
// buildSignedIntent from sign-intent.mjs asks the API for a nonce and a window
// on every call. That is right for a person and far too slow for twenty
// thousand intents, so signRaw signs any payload locally, including payloads
// that are deliberately wrong but validly signed.

import {readFileSync} from "node:fs";
import {concatHex, numberToHex, parseSignature, serializeCompactSignature, serializeSignature, signatureToCompactSignature, toHex} from "viem";
import {generatePrivateKey, mnemonicToAccount, privateKeyToAccount} from "viem/accounts";
import {FORK_RPC} from "./fork.mjs";

process.env.NOKTURN_API_RPC ??= FORK_RPC;

const chainModule = await import("../../../../api/src/chain.ts");
const {initChain, chain, permit2Abi, read, settlementAbi} = chainModule;
const {decodeIntent, intentHash, witnessDigest} = await import("../../../../api/src/permit2.ts");

const accounts = JSON.parse(readFileSync(new URL("../../../accounts.json", import.meta.url), "utf8"));

const MNEMONIC =
  process.env.NOKTURN_FORK_MNEMONIC ?? "spin skill strategy deal rebel image eager original crowd baby inhale calm";

/** Index six is users[0], the same scheme sign-intent.mjs and check-permit2.mjs assert. */
const USER_INDEX_BASE = 6;

await initChain();
export const ctx = chain();

export const abis = {
  settlement: chainModule.settlementAbi,
  permit2: chainModule.permit2Abi,
  erc20: chainModule.erc20Abi,
  oracle: chainModule.oracleAbi,
  session: chainModule.sessionAbi,
  mandate: chainModule.mandateAbi,
};

export const users = accounts.users.map((expected, i) => {
  const derived = mnemonicToAccount(MNEMONIC, {addressIndex: USER_INDEX_BASE + i});
  if (derived.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`mnemonic index ${USER_INDEX_BASE + i} derives ${derived.address}, accounts.json says ${expected}`);
  }
  return derived;
});

export const accountsFile = accounts;

/** A key nobody funded, for signatures that must come from the wrong person. */
export function strangerAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

export async function assertEoa(address) {
  const code = await ctx.client.getCode({address});
  if (code && code !== "0x") throw new Error(`${address} carries code, refusing to sign as it`);
}

let witness = null;

export async function witnessParts() {
  if (!witness) {
    const [domainSeparator, witnessTypeString] = await Promise.all([
      read(ctx.permit2, permit2Abi, "DOMAIN_SEPARATOR"),
      read(ctx.deployment.settlement, settlementAbi, "WITNESS_TYPE_STRING"),
    ]);
    witness = {domainSeparator, witnessTypeString};
  }
  return witness;
}

export async function digestOf(payload, {spender = ctx.deployment.settlement, domainSeparator} = {}) {
  const parts = await witnessParts();
  return witnessDigest({
    domainSeparator: domainSeparator ?? parts.domainSeparator,
    witnessTypeString: parts.witnessTypeString,
    intent: decodeIntent(payload),
    spender,
  });
}

export function hashOf(payload) {
  return intentHash(decodeIntent(payload));
}

export const NVDA = () => ctx.tokens.find((t) => t.symbol === "NVDA");
export const USDG = () => ctx.quote;

/**
 * A payload that is valid for any batch collecting between now and thirty days
 * from now in any session, so warping the fork does not expire it by accident.
 * A scenario that is about validity windows or sessions overrides the fields.
 */
export function makeIntent({owner, nonce, now, ...fields}) {
  return {
    owner,
    receiver: owner,
    sellToken: USDG().address,
    buyToken: NVDA().token,
    sellAmount: "1000000",
    minBuyAmount: "1",
    validAfter: String(Number(now) - 60),
    validUntil: String(Number(now) + 30 * 86_400),
    flags: "1",
    kind: "0",
    maxDevFromRefBps: "0",
    allowedSessions: "255",
    batchSpan: "1",
    nonce: String(nonce),
    ...fields,
  };
}

/** Signs whatever payload it is given with account, valid or not. */
export async function signRaw(payload, account, digestOptions) {
  const digest = await digestOf(payload, digestOptions);
  const signature = await account.sign({hash: digest});
  return {intent: payload, signature, digest};
}

/** Signs a digest the caller computed, for signatures over the wrong thing. */
export async function signHash(hash, account) {
  return account.sign({hash});
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * The four encodings of one valid signature that a verifier might disagree
 * about. v 27 or 28, v 0 or 1, EIP-2098 compact, and the malleated high s twin.
 */
export function signatureForms(signature) {
  const sig = parseSignature(signature);
  const yParity = sig.yParity ?? Number(sig.v) - 27;
  const highS = numberToHex(SECP256K1_N - BigInt(sig.s), {size: 32});
  return {
    v27: serializeSignature({r: sig.r, s: sig.s, yParity}),
    v01: concatHex([sig.r, sig.s, toHex(yParity, {size: 1})]),
    compact: serializeCompactSignature(signatureToCompactSignature({r: sig.r, s: sig.s, yParity})),
    highS: serializeSignature({r: sig.r, s: highS, yParity: yParity ^ 1}),
  };
}

/**
 * sign-intent.mjs's own builder, pointed at the harness API. Imported lazily
 * because that module resolves its API URL at import time.
 */
export async function buildSignedIntent(apiUrl, overrides) {
  process.env.NOKTURN_API_URL = apiUrl;
  const mod = await import("../../sign-intent.mjs");
  return mod.buildSignedIntent(overrides);
}
