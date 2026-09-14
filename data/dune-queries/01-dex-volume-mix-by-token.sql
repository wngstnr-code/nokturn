-- Robinhood Chain — DEX volume mix by token (Jul 2026)
-- What share of Robinhood Chain DEX volume is actually stock tokens vs memecoins/crypto
-- Dune query id: 8194489  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: column — x=sym (sort_x=false), y=volume_usd ($0.0a)

WITH legs AS (
  SELECT token_bought_symbol AS sym, token_bought_address AS addr, amount_usd, block_time
  FROM dex.trades
  WHERE blockchain = 'robinhood' AND block_month >= DATE '2026-07-01'
  UNION ALL
  SELECT token_sold_symbol, token_sold_address, amount_usd, block_time
  FROM dex.trades
  WHERE blockchain = 'robinhood' AND block_month >= DATE '2026-07-01'
)
SELECT sym,
       COUNT(*) AS legs,
       SUM(amount_usd) AS volume_usd,
       SUM(amount_usd) * 100.0 / SUM(SUM(amount_usd)) OVER () AS pct_of_volume
FROM legs
WHERE amount_usd IS NOT NULL
GROUP BY 1
ORDER BY volume_usd DESC
LIMIT 30
