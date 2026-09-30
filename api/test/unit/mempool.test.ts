import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {setFlagsFromString} from "node:v8";
import {runInNewContext} from "node:vm";
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

  // The heap after a forced collection, which is what C1-7 cannot see from
  // outside the process. There the RSS keeps a step V8 took while sizing its
  // old space, and a slope over it reads as a leak that is not there.
  test("the heap stays flat across 20000 intents in 200 swept batches", () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const heap = () => {
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };
    // Batches a thousand seconds apart, so the default day of retention is
    // passed inside the first hundred and the second hundred is steady state.
    const step = 1_000n;
    const retained = Number((10n + FINALIZE_DEADLINE + STATUS_RETENTION) / step + 2n) * 100;
    const start = 3_000_000n;
    let warm = 0;
    let most = 0;
    for (let b = 0; b < 200; b += 1) {
      const batch = start + BigInt(b) * step;
      for (let i = 0; i < 100; i += 1) {
        const hash = `0x${(b * 100 + i).toString(16).padStart(64, "0")}`;
        const owner = `0x${(b * 100 + i).toString(16).padStart(40, "0")}`;
        admit(hash, {...signed(hash, String(b * 100 + i), Number(batch + 70n)), intent: {owner, nonce: String(b * 100 + i), validUntil: Number(batch + 70n)} as unknown as SignedIntent["intent"]}, batch);
      }
      sweep(batch + 1n);
      most = Math.max(most, remembered());
      if (b === 100) warm = heap();
    }
    const perIntent = (heap() - warm) / 10_000;
    assert.ok(most <= retained, `${most} intents remembered at once, the retention allows ${retained}`);
    assert.ok(perIntent < 64, `the heap grew ${perIntent.toFixed(1)} bytes per intent across the second hundred batches`);
  });
});
