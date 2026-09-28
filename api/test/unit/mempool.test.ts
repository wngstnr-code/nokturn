import assert from "node:assert/strict";
import {describe, test} from "node:test";
import type {SignedIntent} from "../../../packages/shared/api-types.ts";
import {FINALIZE_DEADLINE, STATUS_RETENTION, admit, getByHash, heldNonces, remembered, sweep} from "../../src/mempool.ts";

const OWNER = "0xc3e87ba4132708838243a717c4b90112271ceee3";

function signed(hash: string, nonce: string, validUntil: number): SignedIntent {
  return {
    intentHash: hash as `0x${string}`,
    intent: {owner: OWNER, nonce, validUntil} as unknown as SignedIntent["intent"],
    signature: "0x",
    signatureKind: "eoa",
    receivedAt: 0,
  };
}

describe("mempool retention, D6", () => {
  test("an intent is forgotten a day after its batch closed, and not before", () => {
    const batch = 1_000_000n;
    admit("0xd6a", signed("0xd6a", "1", 1_000_100), batch);
    const closed = batch + 10n + FINALIZE_DEADLINE;
    const before = remembered();

    sweep(closed + STATUS_RETENTION);
    assert.equal(getByHash("0xd6a")?.status, "expired");

    sweep(closed + STATUS_RETENTION + 1n);
    assert.equal(getByHash("0xd6a"), null);
    assert.equal(remembered(), before - 1);
  });

  test("the status goes with the retention, the nonce stays held until validUntil", () => {
    const batch = 2_000_000n;
    const validUntil = Number(batch + 10n + FINALIZE_DEADLINE + STATUS_RETENTION + 500n);
    admit("0xd6b", signed("0xd6b", "2", validUntil), batch);

    sweep(batch + 10n + FINALIZE_DEADLINE + STATUS_RETENTION + 1n);
    assert.equal(getByHash("0xd6b"), null);
    assert.ok(heldNonces(OWNER).has(2n), "the nonce was released while its signature could still settle");
    assert.throws(() => admit("0xd6c", signed("0xd6c", "2", validUntil), batch + 60n), /already used nonce 2/);

    sweep(BigInt(validUntil) + 1n);
    assert.ok(!heldNonces(OWNER).has(2n));
  });
});
