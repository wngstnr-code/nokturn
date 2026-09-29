import assert from "node:assert/strict";
import {describe, test} from "node:test";
import type {SignedIntent} from "../../../packages/shared/api-types.ts";
import {admit, committed, getByBatch, getByHash, heldNonces, withdraw, withdrawnFrom} from "../../src/mempool.ts";
import {screen, type OwnerFacts} from "../../src/revalidate.ts";

const A = "0xc3e87ba4132708838243a717c4b90112271ceee3";
const B = "0x14e9ef9fd45e6b1e8dbc229ddc3212db1d21a0ab";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

function signed(hash: string, owner: string, sellToken: string, sellAmount: bigint, nonce: bigint): SignedIntent {
  return {
    intentHash: hash as `0x${string}`,
    intent: {owner, sellToken, sellAmount: String(sellAmount), nonce: String(nonce), validUntil: 9_999_999_999} as unknown as SignedIntent["intent"],
    signature: "0x",
    signatureKind: "eoa",
    receivedAt: 0,
  };
}

function facts(balances: Record<string, bigint>, spent: string[] = [], allowances: Record<string, bigint> = {}): OwnerFacts {
  const k = (o: string, t: string) => `${o.toLowerCase()}:${t.toLowerCase()}`;
  return {
    balance: (o, t) => balances[k(o, t)] ?? 0n,
    allowance: (o, t) => allowances[k(o, t)] ?? 2n ** 255n,
    nonceUsed: (o, n) => spent.includes(`${o.toLowerCase()}:${n}`),
  };
}

describe("screening a batch against what Permit2 would pull, D4 and N3", () => {
  test("twenty intents selling one balance keep only the first", () => {
    const list = Array.from({length: 20}, (_, i) => signed(`0x${i}`, A, USDG, 100n, BigInt(i)));
    const {keep, withdrawn} = screen(list, facts({[`${A}:${USDG}`]: 100n}));
    assert.deepEqual(keep.map((s) => s.intentHash), ["0x0"]);
    assert.equal(withdrawn.length, 19);
    assert.ok(withdrawn.every((w) => w.rejection.code === "COORDINATOR_INSUFFICIENT_BALANCE"));
    assert.equal(withdrawn[0]!.rejection.detail?.committed, "100");
  });

  test("a later intent never pushes out an earlier one", () => {
    const list = [signed("0x1", A, USDG, 60n, 1n), signed("0x2", A, USDG, 60n, 2n), signed("0x3", A, USDG, 40n, 3n)];
    const {keep} = screen(list, facts({[`${A}:${USDG}`]: 100n}));
    assert.deepEqual(keep.map((s) => s.intentHash), ["0x1", "0x3"]);
  });

  test("balances are counted per owner and per token", () => {
    const list = [signed("0x1", A, USDG, 100n, 1n), signed("0x2", A, NVDA, 5n, 2n), signed("0x3", B, USDG, 100n, 1n)];
    const {keep} = screen(list, facts({[`${A}:${USDG}`]: 100n, [`${A}:${NVDA}`]: 5n, [`${B}:${USDG}`]: 100n}));
    assert.equal(keep.length, 3);
  });

  test("a spent nonce, a moved balance and a revoked allowance each name their own code", () => {
    const list = [signed("0x1", A, USDG, 10n, 7n), signed("0x2", B, USDG, 10n, 1n), signed("0x3", A, NVDA, 1n, 8n)];
    const {keep, withdrawn} = screen(
      list,
      facts({[`${A}:${USDG}`]: 10n, [`${B}:${USDG}`]: 0n, [`${A}:${NVDA}`]: 1n}, [`${A}:7`], {[`${A}:${NVDA}`]: 0n}),
    );
    assert.equal(keep.length, 0);
    assert.deepEqual(withdrawn.map((w) => w.rejection.code), ["NonceAlreadyUsed", "COORDINATOR_INSUFFICIENT_BALANCE", "COORDINATOR_PERMIT2_NOT_APPROVED"]);
  });

  test("a withdrawn intent leaves the batch, frees its nonce and is reported", () => {
    const batch = 3_000_000n;
    admit("0xe1", signed("0xe1", A, USDG, 10n, 41n), batch);
    admit("0xe2", signed("0xe2", A, USDG, 10n, 42n), batch);
    assert.equal(committed(A, USDG).filter((p) => p.batchId === batch).length, 2);

    withdraw("0xe1", {code: "NonceAlreadyUsed", message: "spent"});
    assert.equal(getByHash("0xe1")?.status, "rejected");
    assert.equal(getByHash("0xe1")?.rejection?.code, "NonceAlreadyUsed");
    assert.deepEqual(getByBatch(batch).map((s) => s.intentHash), ["0xe2"]);
    assert.ok(!heldNonces(A).has(41n));
    assert.deepEqual(withdrawnFrom(batch).map((w) => w.intentHash), ["0xe1"]);
    assert.equal(committed(A, USDG).filter((p) => p.batchId === batch).length, 1);

    withdraw("0xe1", {code: "NonceAlreadyUsed", message: "again"});
    assert.equal(withdrawnFrom(batch).length, 1, "a second withdraw of the same intent is ignored");
  });
});
