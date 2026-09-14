-- Nokturn — netting quality: real counterparties vs self-round-trips
-- Does the netting come from two distinct traders, or from one address buying and
-- selling inside the same window (arb/MEV round-trip)? 45s batches, off-hours.
-- Dune query id: 8194523  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: counter — netting_pct_excl_self_roundtrip, suffix %
-- Verified 2026-08-02: naive 47.59% -> clean 41.33%, 6.54% of volume from self-RT,
--                      5.33 distinct traders per batch

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
tagged AS (
    SELECT sym, CAST(floor(to_unixtime(block_time) / 45) AS bigint) AS bucket,
           trader, side, amount_usd
    FROM legs
    WHERE day_of_week(block_time) < 6
      AND NOT (hour(block_time)*60 + minute(block_time) >= 810
           AND hour(block_time)*60 + minute(block_time) <  1200)
),
self_rt AS (
    SELECT sym, bucket, trader
    FROM tagged
    GROUP BY 1, 2, 3
    HAVING count(DISTINCT side) = 2
),
per_batch AS (
    SELECT t.sym, t.bucket,
        sum(CASE WHEN t.side='buy'  THEN t.amount_usd ELSE 0 END) AS buy_all,
        sum(CASE WHEN t.side='sell' THEN t.amount_usd ELSE 0 END) AS sell_all,
        sum(CASE WHEN t.side='buy'  AND s.trader IS NULL THEN t.amount_usd ELSE 0 END) AS buy_clean,
        sum(CASE WHEN t.side='sell' AND s.trader IS NULL THEN t.amount_usd ELSE 0 END) AS sell_clean,
        count(DISTINCT t.trader) AS n_traders,
        count(DISTINCT s.trader) AS n_self_rt
    FROM tagged t
    LEFT JOIN self_rt s ON s.sym = t.sym AND s.bucket = t.bucket AND s.trader = t.trader
    GROUP BY 1, 2
)
SELECT
    count(*) AS n_batches,
    round(sum(buy_all + sell_all)) AS total_usd,
    round(100.0 * sum(2*least(buy_all, sell_all)) / sum(buy_all + sell_all), 2) AS netting_pct_naive,
    round(100.0 * sum(2*least(buy_clean, sell_clean)) / sum(buy_all + sell_all), 2) AS netting_pct_excl_self_roundtrip,
    round(100.0 * sum(buy_all + sell_all - buy_clean - sell_clean) / sum(buy_all + sell_all), 2) AS pct_volume_from_self_rt,
    sum(n_self_rt) AS n_self_rt_traders,
    round(avg(n_traders), 2) AS avg_distinct_traders_per_batch
FROM per_batch
