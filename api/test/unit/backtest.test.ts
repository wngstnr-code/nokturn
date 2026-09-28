import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {describe, test} from "node:test";
import {CURVE_FILE, loadNettingCurve} from "../../src/routes/backtest.ts";

const text = readFileSync(CURVE_FILE, "utf8");

describe("netting curve", () => {
  test("every row is labelled BACKTEST and the source names a public query", () => {
    const c = loadNettingCurve(text);
    assert.equal(c.label, "BACKTEST");
    assert.equal(c.source.duneQueryId, 8595303);
    assert.equal(c.rows.length, 30);
    assert.ok(c.rows.every((r) => r.label === "BACKTEST"));
  });

  test("the off hours line is the one parameter.md and the pitch quote", () => {
    const off = loadNettingCurve(text).rows.filter((r) => r.session === "off_hours_weekday");
    const at = (share: number) => off.find((r) => r.sharePct === share)!;
    assert.equal(at(5).nettingCounterpartyPct, 21.43);
    assert.equal(at(10).nettingCounterpartyPct, 27.19);
    assert.equal(at(20).nettingCounterpartyPct, 33.39);
    assert.equal(at(100).nettingCounterpartyPct, 50.05);
    assert.equal(at(100).nettingGrossPct, 63.76);
  });

  test("a file without its label or a session is refused, not served", () => {
    const raw = JSON.parse(text);
    assert.throws(() => loadNettingCurve(JSON.stringify({...raw, label: "measured"})), /BACKTEST/);
    assert.throws(() => loadNettingCurve(JSON.stringify({...raw, rows: raw.rows.filter((r: {session: string}) => r.session !== "weekend")})), /weekend/);
  });
});
