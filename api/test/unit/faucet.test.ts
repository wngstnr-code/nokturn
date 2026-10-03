import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {Window, clientIp, shortfall} from "../../src/routes/faucet.ts";

describe("faucet", () => {
  test("tops up to the target and never past it", () => {
    assert.equal(shortfall(0n, 100n), 100n);
    assert.equal(shortfall(40n, 100n), 60n);
    assert.equal(shortfall(100n, 100n), 0n);
    assert.equal(shortfall(250n, 100n), 0n);
  });

  test("a window refuses past its limit and says how long to wait", () => {
    const w = new Window(2, 3600);
    assert.equal(w.take("a", 1000), 0);
    assert.equal(w.take("a", 1010), 0);
    assert.equal(w.take("a", 1020), 3580);
    assert.equal(w.take("b", 1020), 0);
    assert.equal(w.take("a", 4600), 0);
  });

  test("the client ip is the entry the proxy appended last", () => {
    assert.equal(clientIp("1.1.1.1, 9.9.9.9", "10.0.0.1"), "9.9.9.9");
    assert.equal(clientIp(["1.1.1.1", "9.9.9.9"], "10.0.0.1"), "9.9.9.9");
    assert.equal(clientIp(undefined, "10.0.0.1"), "10.0.0.1");
    assert.equal(clientIp("", "10.0.0.1"), "10.0.0.1");
  });
});
