import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {redactUrls} from "../../../packages/shared/rpc.ts";

describe("redacting urls in free text", () => {
  test("a viem message loses the key and keeps the host", () => {
    const message = 'HTTP request failed.\n\nStatus: 429\nURL: https://robinhood-mainnet.g.alchemy.com/v2/abc123key\nRequest body: {"method":"eth_call"}';
    const out = redactUrls(message);
    assert.ok(!out.includes("abc123key"));
    assert.ok(out.includes("https://robinhood-mainnet.g.alchemy.com/<redacted>"));
    assert.ok(out.includes("Status: 429"));
  });

  test("every url in the text, including one inside json quotes", () => {
    const out = redactUrls('{"a":"https://x.io/k1","b":"http://127.0.0.1:8545/k2"} https://y.io/v2/k3.');
    assert.ok(!/k1|k2|k3/.test(out), out);
  });

  test("a url with no path is left as it is", () => {
    assert.equal(redactUrls("fork at http://127.0.0.1:8545 down"), "fork at http://127.0.0.1:8545 down");
  });
});
