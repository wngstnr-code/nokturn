-- Nokturn — netting ratio vs market share (sensitivity)
-- How netting ratio degrades when Nokturn captures only a fraction of flow.
-- Samples by taker address (Nokturn captures users, not random trades), 45s batches, off-hours.
-- Dune query id: 8194516  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: line — x=nokturn_share_pct, y_left=netting_pct + pct_batches_two_sided,
--                y_right=avg_trades_per_batch
-- Verified 2026-08-02: 5% -> 18.51%, 10% -> 20.95%, 20% -> 28.68%, 100% -> 47.59%
--
-- Pitch with 21-29% (realistic 10-20% share), never 47.59% — the latter assumes
-- Nokturn monopolises flow. The SLOPE is the argument, not any single point.

WITH toks AS (
    SELECT * FROM (VALUES
        (0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec, 'NVDA'),
        (0xaf3d76f1834a1d425780943c99ea8a608f8a93f9, 'AAPL'),
        (0x322f0929c4625ed5bad873c95208d54e1c003b2d, 'TSLA'),
        (0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3, 'GOOGL')
    ) AS t(addr, sym)
),
legs AS (
    SELECT d.block_time, t.sym, 'buy' AS side, d.amount_usd, d.tx_from AS trader
    FROM dex.trades d JOIN toks t ON d.token_bought_address = t.addr
    WHERE d.blockchain = 'robinhood' AND d.block_month = DATE '2026-07-01'
      AND d.token_sold_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
      AND d.amount_usd BETWEEN 0.01 AND 10000000
    UNION ALL
    SELECT d.block_time, t.sym, 'sell', d.amount_usd, d.tx_from
    FROM dex.trades d JOIN toks t ON d.token_sold_address = t.addr
    WHERE d.blockchain = 'robinhood' AND d.block_month = DATE '2026-07-01'
      AND d.token_bought_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
      AND d.amount_usd BETWEEN 0.01 AND 10000000
),
shares AS (SELECT * FROM (VALUES (5),(10),(20),(35),(50),(75),(100)) AS s(pct)),
sampled AS (
    SELECT s.pct, l.*
    FROM legs l CROSS JOIN shares s
    WHERE abs(from_big_endian_64(bytearray_substring(sha256(l.trader), 1, 8))) % 100 < s.pct
),
bucketed AS (
    SELECT pct, sym,
        CAST(floor(to_unixtime(block_time) / 45) AS bigint) AS bucket,
        sum(CASE WHEN side = 'buy'  THEN amount_usd ELSE 0 END) AS buy_usd,
        sum(CASE WHEN side = 'sell' THEN amount_usd ELSE 0 END) AS sell_usd,
        count(*) AS n_trades
    FROM sampled
    WHERE day_of_week(block_time) < 6
      AND NOT (hour(block_time)*60 + minute(block_time) >= 810
           AND hour(block_time)*60 + minute(block_time) <  1200)
    GROUP BY 1, 2, 3
)
SELECT
    pct AS nokturn_share_pct,
    count(*) AS n_batches,
    sum(n_trades) AS n_trades,
    round(sum(buy_usd + sell_usd)) AS total_usd,
    round(100.0 * sum(2 * least(buy_usd, sell_usd)) / sum(buy_usd + sell_usd), 2) AS netting_pct,
    round(100.0 * count_if(least(buy_usd, sell_usd) > 0) / count(*), 1) AS pct_batches_two_sided,
    round(avg(n_trades), 2) AS avg_trades_per_batch
FROM bucketed
GROUP BY 1
ORDER BY 1
