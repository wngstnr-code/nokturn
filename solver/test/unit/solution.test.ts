import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {hexToBigInt, size, slice} from "viem";
import {encodeSolution, orderTokens, packExecutions, packIntents, solutionHash} from "../../src/solution.ts";
import {AAPL, NVDA, QUOTE, TSLA, intent, solution} from "./fixtures.ts";

describe("packing", () => {
  test("every packed intent and execution is 72 bytes", () => {
    const s = solution();
    assert.equal(size(packIntents(s.intents, s.tokens)), 72 * s.intents.length);
    assert.equal(size(packExecutions(s.executions)), 72 * s.executions.length);
    assert.equal(packIntents([], s.tokens), "0x");
  });

  test("an intent decodes back to the fields it was packed from", () => {
    const i = intent({sellToken: NVDA, buyToken: QUOTE, sellAmount: 7n * 10n ** 18n, minBuyAmount: 123_456_789n, flags: 1});
    const word = packIntents([i], [QUOTE, NVDA]);
    assert.equal(hexToBigInt(slice(word, 0, 2)), 1n);
    assert.equal(hexToBigInt(slice(word, 2, 4)), 0n);
    assert.equal(hexToBigInt(slice(word, 4, 5)), 1n);
    assert.equal(slice(word, 5, 8), "0x000000");
    assert.equal(hexToBigInt(slice(word, 8, 40)), i.sellAmount);
    assert.equal(hexToBigInt(slice(word, 40, 72)), i.minBuyAmount);
  });

  test("an execution decodes back to the fields it was packed from", () => {
    const e = {intentIndex: 3n, executedSell: 2n ** 200n + 5n, executedBuy: 9n};
    const word = packExecutions([e]);
    assert.equal(hexToBigInt(slice(word, 0, 4)), 3n);
    assert.equal(slice(word, 4, 8), "0x00000000");
    assert.equal(hexToBigInt(slice(word, 8, 40)), e.executedSell);
    assert.equal(hexToBigInt(slice(word, 40, 72)), e.executedBuy);
  });

  test("a token outside the list is refused, as Settlement._tokenIndex reverts", () => {
    assert.throws(() => packIntents([intent({sellToken: TSLA, buyToken: QUOTE, sellAmount: 1n, minBuyAmount: 1n})], [QUOTE, NVDA]));
  });
});

describe("token order", () => {
  const legs = [
    intent({sellToken: TSLA, buyToken: QUOTE, sellAmount: 1n, minBuyAmount: 1n}),
    intent({sellToken: QUOTE, buyToken: NVDA, sellAmount: 1n, minBuyAmount: 1n}),
    intent({sellToken: AAPL, buyToken: QUOTE, sellAmount: 1n, minBuyAmount: 1n}),
    intent({sellToken: NVDA, buyToken: TSLA, sellAmount: 1n, minBuyAmount: 1n}),
  ];

  test("the quote asset is index 0 whatever order the intents arrive in", () => {
    const orders = [legs, [...legs].reverse(), [legs[2]!, legs[0]!, legs[3]!, legs[1]!]];
    const lists = orders.map((o) => orderTokens(o, QUOTE));
    for (const list of lists) assert.equal(list[0], QUOTE);
    for (const list of lists) assert.deepEqual(list, lists[0]);
    assert.equal(new Set(lists[0]!.map((t) => t.toLowerCase())).size, 4);
  });

  test("the quote asset leads even when no intent touches it", () => {
    assert.equal(orderTokens([legs[3]!], QUOTE)[0], QUOTE);
  });
});

describe("hash", () => {
  test("is stable for the same solution and moves with one wei", () => {
    const a = solution();
    assert.equal(solutionHash(a), solutionHash(solution()));
    const b = solution();
    b.executions[1]!.executedBuy += 1n;
    assert.notEqual(solutionHash(a), solutionHash(b));
  });

  test("calldata carries the submitSolution selector", () => {
    assert.match(encodeSolution(solution()), /^0x[0-9a-f]{8}/);
  });
});
