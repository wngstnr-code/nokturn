-- Robinhood Chain — Stock token execution quality by UTC hour
-- Median absolute price move between consecutive trades (proxy for effective spread)
-- and trade size, by hour. NOT a quoted spread — do not present it as one.
-- Dune query id: 8194494  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: column — x=utc_hour, y=median_move_bps + p90_move_bps (0,0.0)

WITH stock AS (
  SELECT DISTINCT output_0 AS addr FROM robinhood_robinhood.stockfactory_call_deploy WHERE call_success
),
t AS (
  SELECT d.block_time,
    COALESCE(sb.addr, ss.addr) AS token,
    CASE WHEN sb.addr IS NOT NULL THEN d.amount_usd / NULLIF(d.token_bought_amount, 0)
         ELSE d.amount_usd / NULLIF(d.token_sold_amount, 0) END AS px,
    d.amount_usd
  FROM dex.trades d
  LEFT JOIN stock sb ON d.token_bought_address = sb.addr
  LEFT JOIN stock ss ON d.token_sold_address = ss.addr
  WHERE d.blockchain = 'robinhood' AND d.block_month >= DATE '2026-07-01'
    AND (sb.addr IS NOT NULL OR ss.addr IS NOT NULL)
    AND d.amount_usd > 100
),
r AS (
  SELECT hour(block_time) AS utc_hour, amount_usd,
    ABS(LN(px / LAG(px) OVER (PARTITION BY token ORDER BY block_time))) AS abs_ret
  FROM t WHERE px > 0
)
SELECT utc_hour,
  CASE WHEN utc_hour >= 13 AND utc_hour < 20 THEN 'NYSE open' ELSE 'closed' END AS session,
  COUNT(*) AS trades,
  APPROX_PERCENTILE(amount_usd, 0.5) AS median_trade_usd,
  APPROX_PERCENTILE(abs_ret, 0.5) * 10000 AS median_move_bps,
  APPROX_PERCENTILE(abs_ret, 0.9) * 10000 AS p90_move_bps
FROM r
WHERE abs_ret IS NOT NULL AND abs_ret < 0.5
GROUP BY 1, 2
ORDER BY 1
