import assert from "node:assert/strict";
import {describe, test} from "node:test";
import type {Provenance, TokenRef} from "../../../packages/shared/api-types.ts";
import {parseAuctionId, shape, sufficient, toWad, type AuctionFacts} from "../../src/routes/auctions.ts";

const token: TokenRef = {address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA", decimals: 18, explorerUrl: "x"};
const prov: Provenance = {chainId: 4663, blockNumber: "1", blockTimestamp: 1, source: {kind: "mainnet"}};

// USDG has 6 decimals, so AuctionHouse prices NVDA at 180 dollars as 180e6.
const base: AuctionFacts = {
  token: token.address,
  kind: 1,
  phase: 1,
  collarBps: 200,
  extensions: 0,
  crossAt: 1_790_000_000n,
  clearingPrice: 0n,
  matchedVolume: 0n,
  participants: 0,
  quoteUnit: 10n ** 6n,
  printMinVolume: 1000n * 10n ** 6n,
  printMinParticipants: 5,
  indicative: {price: 180_000_000n, matched: 2n * 10n ** 18n, imbalance: -(3n * 10n ** 18n)},
  committers: 4,
};

describe("auction response", () => {
  test("prices leave in USD at 18 decimals, floored like the closing print", () => {
    assert.equal(toWad(180_000_000n, 10n ** 6n), 180n * 10n ** 18n);
    assert.equal(toWad(1n, 3n), 333_333_333_333_333_333n);
  });

  test("a live book reports the contract's indicative and its committers", () => {
    const r = shape(base, token, 7n, prov);
    assert.equal(r.phase, "disclosing");
    assert.equal(r.kind, "close");
    assert.equal(r.indicativePrice, String(180n * 10n ** 18n));
    assert.equal(r.imbalance, String(-(3n * 10n ** 18n)));
    assert.equal(r.matchedVolume, String(2n * 10n ** 18n));
    assert.equal(r.participantCount, 4);
    assert.equal(r.result, null);
  });

  test("a book without a reference price names no price", () => {
    const r = shape({...base, phase: 2, indicative: null}, token, 7n, prov);
    assert.equal(r.phase, "frozen");
    assert.equal(r.indicativePrice, null);
    assert.equal(r.imbalance, null);
    assert.equal(r.matchedVolume, null);
  });

  test("crossed and executed both report the accepted cross, not the indicative", () => {
    for (const phase of [3, 4]) {
      const r = shape({...base, phase, clearingPrice: 180_000_000n, matchedVolume: 10n ** 19n, participants: 6}, token, 7n, prov);
      assert.equal(r.phase, "crossed");
      assert.equal(r.indicativePrice, null);
      assert.equal(r.participantCount, 6);
      assert.deepEqual(r.result, {price: String(180n * 10n ** 18n), volume: String(10n ** 19n), participants: 6, sufficient: true});
    }
  });

  test("an aborted auction carries no result", () => {
    const r = shape({...base, phase: 5}, token, 7n, prov);
    assert.equal(r.phase, "aborted");
    assert.equal(r.result, null);
    assert.equal(r.indicativePrice, null);
  });

  test("sufficient is _publishPrint's predicate over executeCross's quote volume", () => {
    // 5.555555555555555555 NVDA at 180 is 999.999999 USDG after the floor, one unit short.
    const short = {...base, phase: 4, clearingPrice: 180_000_000n, matchedVolume: 5_555_555_555_555_555_555n, participants: 5};
    assert.equal(sufficient(short), false);
    assert.equal(sufficient({...short, matchedVolume: 5_555_555_555_555_555_556n}), true);
    assert.equal(sufficient({...short, matchedVolume: 10n ** 19n, participants: 4}), false);
    assert.equal(sufficient({...short, kind: 0, matchedVolume: 10n ** 19n}), false);
  });

  test("an id outside uint64 or zero is refused before any read", () => {
    assert.equal(parseAuctionId("12"), 12n);
    for (const bad of ["0", "-1", "1e3", "abc", "18446744073709551616", ""]) {
      assert.throws(() => parseAuctionId(bad), /not an auction id/);
    }
  });
});
