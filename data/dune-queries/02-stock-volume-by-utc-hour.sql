-- Robinhood Chain — Stock token volume by UTC hour vs NYSE session
-- Measures whether off-hours execution demand for tokenized equities is real,
-- and stock token share of total DEX volume
-- Dune query id: 8194490  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: column stacked — x=utc_hour, y=stock_vol_weekday + stock_vol_weekend ($0.0a)

WITH stock AS (
  SELECT DISTINCT output_0 AS addr FROM robinhood_robinhood.stockfactory_call_deploy WHERE call_success
),
legs AS (
  SELECT token_bought_address AS addr, amount_usd, block_time
  FROM dex.trades WHERE blockchain='robinhood' AND block_month >= DATE '2026-07-01'
  UNION ALL
  SELECT token_sold_address, amount_usd, block_time
  FROM dex.trades WHERE blockchain='robinhood' AND block_month >= DATE '2026-07-01'
)
SELECT
  hour(l.block_time) AS utc_hour,
  CASE WHEN hour(l.block_time) >= 13 AND hour(l.block_time) < 20 THEN 'NYSE open' ELSE 'closed' END AS session,
  SUM(CASE WHEN s.addr IS NOT NULL AND day_of_week(l.block_time) <= 5 THEN l.amount_usd ELSE 0 END) AS stock_vol_weekday,
  SUM(CASE WHEN s.addr IS NOT NULL AND day_of_week(l.block_time) > 5 THEN l.amount_usd ELSE 0 END) AS stock_vol_weekend,
  SUM(CASE WHEN s.addr IS NOT NULL THEN l.amount_usd ELSE 0 END) AS stock_vol_total,
  SUM(l.amount_usd) AS all_vol_total
FROM legs l LEFT JOIN stock s ON l.addr = s.addr
WHERE l.amount_usd IS NOT NULL
GROUP BY 1, 2
ORDER BY 1
