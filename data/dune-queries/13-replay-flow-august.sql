-- Nokturn 13, replay flow, August 2026 (allowlist v1.0)
-- One off-hours weekday hour of real trades, one row per trade, the shape the
-- replay harness signs again with local keys on the fork.
-- Same legs as the netting backtest (8595251, 8595303): NVDA, AAPL, TSLA and
-- GOOGL against canonical USDG, August 2026, the same amount_usd bounds.
-- The hour is picked by the data, not by hand. Among off-hours weekday hours in
-- August it is the one whose trade count is the median, never the busiest,
-- because the busiest hour would flatter the netting the replay measures.
-- Off hours uses the backtest's own boundary, NYSE open 13:30 to 20:00 UTC,
-- which is right for August under EDT.
-- Dune query id: 8846173, saved public and permanent on 27 September 2026.
-- Visualization: table

WITH toks AS (
    SELECT * FROM (VALUES
        (0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec, 'NVDA'),
        (0xaf3d76f1834a1d425780943c99ea8a608f8a93f9, 'AAPL'),
        (0x322f0929c4625ed5bad873c95208d54e1c003b2d, 'TSLA'),
        (0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3, 'GOOGL')
    ) AS t(addr, sym)
),
legs AS (
    SELECT d.block_time, d.block_number, d.tx_hash, d.evt_index, t.sym, t.addr AS token,
           'buy' AS side, d.amount_usd,
           d.token_bought_amount_raw AS stock_raw, d.token_sold_amount_raw AS usdg_raw, d.taker
    FROM dex.trades d JOIN toks t ON d.token_bought_address = t.addr
    WHERE d.blockchain = 'robinhood' AND d.block_month = DATE '2026-08-01'
      AND d.token_sold_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
      AND d.amount_usd BETWEEN 0.01 AND 10000000
    UNION ALL
    SELECT d.block_time, d.block_number, d.tx_hash, d.evt_index, t.sym, t.addr,
           'sell', d.amount_usd,
           d.token_sold_amount_raw, d.token_bought_amount_raw, d.taker
    FROM dex.trades d JOIN toks t ON d.token_sold_address = t.addr
    WHERE d.blockchain = 'robinhood' AND d.block_month = DATE '2026-08-01'
      AND d.token_bought_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
      AND d.amount_usd BETWEEN 0.01 AND 10000000
),
off_hours AS (
    SELECT * FROM legs
    WHERE day_of_week(block_time) < 6
      AND NOT (hour(block_time)*60 + minute(block_time) >= 810
           AND hour(block_time)*60 + minute(block_time) <  1200)
),
hours AS (
    SELECT date_trunc('hour', block_time) AS h, count(*) AS n
    FROM off_hours GROUP BY 1
),
ranked AS (
    SELECT h, n, row_number() OVER (ORDER BY n, h) AS rn, count(*) OVER () AS total
    FROM hours
),
pick AS (SELECT h, n, total FROM ranked WHERE rn = (total + 1) / 2)
SELECT
    o.block_time, o.block_number, o.tx_hash, o.evt_index, o.sym, o.token, o.side,
    o.amount_usd, o.stock_raw, o.usdg_raw, o.taker,
    p.h AS window_start, p.n AS window_trades, p.total AS off_hours_hours
FROM off_hours o JOIN pick p ON date_trunc('hour', o.block_time) = p.h
ORDER BY o.block_time, o.evt_index
