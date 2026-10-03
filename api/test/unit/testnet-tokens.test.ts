import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {loadTestnetTokens, type TestnetFixtures} from "../../src/config.ts";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

const fixtures = (feeds: number): TestnetFixtures => ({
  quote: address(1),
  tokens: [10, 11, 12, 13, 14].map(address),
  pools: [20, 21, 22, 23, 24].map(address),
  feeds: [30, 31, 32, 33, 34].slice(0, feeds).map(address),
});

describe("testnet tokens from the 46630 fixtures", () => {
  test("each token carries the mirror feed at its own index", () => {
    const file = loadTestnetTokens(fixtures(5));
    const entries = Object.values(file.tokens);
    assert.deepEqual(entries.map((t) => t.feed), [30, 31, 32, 33, 34].map(address));
    assert.deepEqual(entries.map((t) => t.pool), [20, 21, 22, 23, 24].map(address));
  });

  test("symbols keep the t prefix the test tokens carry on chain", () => {
    assert.deepEqual(Object.keys(loadTestnetTokens(fixtures(5)).tokens), ["tNVDA", "tAAPL", "tTSLA", "tGOOGL", "tGME"]);
  });

  test("a feed list shorter than the tokens is refused rather than misaligned", () => {
    assert.throws(() => loadTestnetTokens(fixtures(4)), /5, 5, 4/);
  });

  test("the record on disk loads with a feed for every token", () => {
    const file = loadTestnetTokens();
    for (const t of Object.values(file.tokens)) assert.match(t.feed, /^0x[0-9a-fA-F]{40}$/);
  });
});
