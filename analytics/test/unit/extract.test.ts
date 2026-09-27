// The rows below exist only inside this test. They are shaped like a query 13
// export so the extractor meets the columns it will meet, and nothing here
// reaches the fixture file or any screen.

import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {extract, parseCsv, toMicro} from "../../src/extract.ts";

const HEAD = "block_time,block_number,tx_hash,evt_index,sym,token,side,amount_usd,stock_raw,usdg_raw,taker,window_start,window_trades,off_hours_hours";
const row = (t: string, tx: string, sym: string, side: string, usd: string, taker: string) => `2026-08-12 ${t}.000 UTC,1,${tx},0,${sym},0xtok,${side},${usd},1,1,${taker},2026-08-12 03:00:00.000 UTC,4,300`;

describe("extract", () => {
  test("usd is read exactly, without a float", () => {
    assert.equal(toMicro("57.44"), 57_440_000n);
    assert.equal(toMicro("0.1234569"), 123_456n);
    assert.equal(toMicro("12"), 12_000_000n);
    assert.throws(() => toMicro("-3"));
  });

  test("a quoted field with a comma and a doubled quote survives", () => {
    const rows = parseCsv('a,b\r\n"x, ""y""",2\r\n');
    assert.deepEqual(rows, [{a: 'x, "y"', b: "2"}]);
  });

  test("every row becomes one trade, in order, with its offset and window", () => {
    const csv = [HEAD, row("03:00:01", "0xa", "NVDA", "buy", "100", "0xT1"), row("03:00:44", "0xb", "NVDA", "sell", "60", "0xT2"), row("03:00:46", "0xc", "AAPL", "buy", "40", "0xT1")].join("\n");
    const f = extract(parseCsv(csv), {queryId: "123", capPerBatchUsdMicro: 1_000_000_000n, extractedAt: "x"});
    assert.equal(f.source.sourceTrades, 3);
    assert.equal(f.source.queryId, "123");
    assert.match(f.source.statement, /query 123/);
    assert.deepEqual(f.trades.map((t) => [t.at, t.window, t.trader, t.txHash]), [[1, 0, 0, "0xa"], [44, 0, 1, "0xb"], [46, 1, 0, "0xc"]]);
    assert.equal(f.traders, 2);
    assert.equal(f.scale.factor, "1.000000");
    assert.equal(f.trades[0]!.usdMicro, "100000000");
  });

  test("the busiest window is scaled under the cap with headroom, and the factor is recorded", () => {
    const csv = [HEAD, row("03:00:01", "0xa", "NVDA", "buy", "1000", "0xT1"), row("03:00:02", "0xb", "TSLA", "sell", "1000", "0xT2"), row("03:10:00", "0xc", "GOOGL", "buy", "100", "0xT3")].join("\n");
    const f = extract(parseCsv(csv), {queryId: "1", capPerBatchUsdMicro: 1_000_000_000n});
    // busiest window 2000 USD, cap 1000 at 90 percent, so every size times 900 / 2000
    assert.equal(f.scale.busiestWindowUsdMicro, "2000000000");
    assert.equal(f.scale.factor, "0.450000");
    assert.deepEqual(f.trades.map((t) => t.usdMicro), ["450000000", "450000000", "45000000"]);
    assert.deepEqual(f.trades.map((t) => t.usdMicroOriginal), ["1000000000", "1000000000", "100000000"]);
  });

  test("a token outside allowlist v1.0 or a row outside the hour is refused, not dropped", () => {
    assert.throws(() => extract(parseCsv([HEAD, row("03:00:01", "0xa", "SPY", "buy", "1", "0xT")].join("\n")), {queryId: "1", capPerBatchUsdMicro: 1n}), /allowlist/);
    assert.throws(() => extract(parseCsv([HEAD, row("04:00:00", "0xa", "NVDA", "buy", "1", "0xT")].join("\n")), {queryId: "1", capPerBatchUsdMicro: 1n}), /outside the window/);
  });
});
