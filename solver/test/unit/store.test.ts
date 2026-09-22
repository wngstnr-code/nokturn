import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, test} from "node:test";
import {solutionHash} from "../../src/solution.ts";
import {Store} from "../../src/store.ts";
import {solution} from "./fixtures.ts";

const fresh = () => new Store(mkdtempSync(join(tmpdir(), "nokturn-store-")));

describe("solution store", () => {
  test("a written solution reads back with the hash submitSolution stored", () => {
    const store = fresh();
    const s = solution();
    const written = store.built(s);
    assert.equal(written.hash, solutionHash(s));
    const back = store.read(s.batchId);
    assert.ok(back.ok);
    assert.equal(back.record.status, "built");
    assert.equal(solutionHash(back.solution), solutionHash(s));
  });

  test("status moves forward and the bytes stay the same", () => {
    const store = fresh();
    const s = solution();
    const {solution: bytes} = store.built(s);
    store.update(s.batchId, {status: "submitted", submitTx: `0x${"ab".repeat(32)}`});
    const back = store.read(s.batchId);
    assert.ok(back.ok);
    assert.equal(back.record.status, "submitted");
    assert.equal(back.record.solution, bytes);
  });

  test("a record whose bytes were tampered with is refused", () => {
    const store = fresh();
    const s = solution();
    store.built(s);
    const path = join(store.dir, `${s.batchId}.json`);
    const record = JSON.parse(readFileSync(path, "utf8"));
    const last = record.solution.slice(-1) === "0" ? "1" : "0";
    record.solution = record.solution.slice(0, -1) + last;
    writeFileSync(path, JSON.stringify(record));
    const back = store.read(s.batchId);
    assert.equal(back.ok, false);
    assert.match((back as {reason: string}).reason, /does not match/);
  });

  test("a write cut off before the rename leaves the previous record whole", () => {
    const store = fresh();
    const s = solution();
    store.built(s);
    // What a crash between writeFileSync and renameSync leaves behind.
    writeFileSync(join(store.dir, `${s.batchId}.json.999.tmp`), "{\"batchId\": \"17899");
    const back = store.read(s.batchId);
    assert.ok(back.ok);
    assert.equal(back.record.status, "built");
    assert.deepEqual(store.batchIds(), [String(s.batchId)]);
    assert.equal(readdirSync(store.dir).length, 2);
  });

  test("a half written record is reported, not thrown", () => {
    const store = fresh();
    writeFileSync(join(store.dir, "1789900000.json"), "{\"batchId\": \"17899");
    const back = store.read(1_789_900_000n);
    assert.equal(back.ok, false);
    assert.match((back as {reason: string}).reason, /unreadable/);
  });
});
