-- Nokturn — netting ratio backtest (allowlist v1.0)
-- Historical netting ratio for NVDA/AAPL/TSLA/GOOGL vs canonical USDG, swept across
-- batch durations and market sessions. netted = 2*min(buy,sell) per (token, window).
-- Dune query id: 8194513  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: column — x=batch_sec, group_by=session, y=netting_pct (0.0)
-- Verified 2026-08-02: 45s / OFF_HOURS = 47.59%

WITH toks AS (
    SELECT * FROM (VALUES
        (0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec, 'NVDA'),
        (0xaf3d76f1834a1d425780943c99ea8a608f8a93f9, 'AAPL'),
        (0x322f0929c4625ed5bad873c95208d54e1c003b2d, 'TSLA'),
        (0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3, 'GOOGL')
    ) AS t(addr, sym)
),
legs AS (
    SELECT d.block_time, t.sym, 'buy' AS side, d.amount_usd
    FROM dex.trades d JOIN toks t ON d.token_bought_address = t.addr
    WHERE d.blockchain = 'robinhood' AND d.block_month = DATE '2026-07-01'
      AND d.token_sold_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
      AND d.amount_usd BETWEEN 0.01 AND 10000000
    UNION ALL
    SELECT d.block_time, t.sym, 'sell', d.amount_usd
    FROM dex.trades d JOIN toks t ON d.token_sold_address = t.addr
    WHERE d.blockchain = 'robinhood' AND d.block_month = DATE '2026-07-01'
      AND d.token_bought_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
      AND d.amount_usd BETWEEN 0.01 AND 10000000
),
w AS (SELECT * FROM (VALUES (10),(30),(45),(60),(120),(300)) AS x(sec)),
bucketed AS (
    SELECT
        w.sec,
        CASE WHEN day_of_week(l.block_time) >= 6 THEN 'WEEKEND'
             WHEN hour(l.block_time)*60 + minute(l.block_time) >= 810
              AND hour(l.block_time)*60 + minute(l.block_time) <  1200 THEN 'NYSE_OPEN'
             ELSE 'OFF_HOURS' END AS session,
        CAST(floor(to_unixtime(l.block_time) / w.sec) AS bigint) AS bucket,
        l.sym,
        sum(CASE WHEN l.side = 'buy'  THEN l.amount_usd ELSE 0 END) AS buy_usd,
        sum(CASE WHEN l.side = 'sell' THEN l.amount_usd ELSE 0 END) AS sell_usd,
        count(*) AS n_trades
    FROM legs l CROSS JOIN w
    GROUP BY 1, 2, 3, 4
)
SELECT
    sec AS batch_sec,
    session,
    count(*) AS n_batches,
    sum(n_trades) AS n_trades,
    round(sum(buy_usd + sell_usd)) AS total_usd,
    round(sum(2 * least(buy_usd, sell_usd))) AS netted_usd,
    round(100.0 * sum(2 * least(buy_usd, sell_usd)) / sum(buy_usd + sell_usd), 2) AS netting_pct,
    round(100.0 * count_if(least(buy_usd, sell_usd) > 0) / count(*), 1) AS pct_batches_two_sided,
    round(avg(n_trades), 2) AS avg_trades_per_batch
FROM bucketed
GROUP BY 1, 2
ORDER BY 1, 2
