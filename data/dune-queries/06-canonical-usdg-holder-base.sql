-- Robinhood Chain — canonical USDG holder base
-- Real saver base on canonical USDG (Global Dollar, 6 decimals)
-- Dune query id: 8194509  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: column — x=bucket, y_left=wallets (0,0), y_right=total_usd ($0.0a)
--
-- WARNING: this query has NO date filter. Balances are cumulative all-time and
-- drift upward over time. Do not present its output as a July 2026 snapshot.

WITH flows AS (
  SELECT t."to" AS wallet, CAST(t.value AS double) / 1e6 AS amt
  FROM erc20_robinhood.evt_transfer t
  WHERE t.contract_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
  UNION ALL
  SELECT t."from", -CAST(t.value AS double) / 1e6
  FROM erc20_robinhood.evt_transfer t
  WHERE t.contract_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
),
bal AS (
  SELECT wallet, SUM(amt) AS usd
  FROM flows
  WHERE wallet <> 0x0000000000000000000000000000000000000000
  GROUP BY 1
  HAVING SUM(amt) > 0.000001
)
SELECT
  CASE WHEN usd < 10 THEN 'a. < $10 (debu)'
       WHEN usd < 100 THEN 'b. $10 - $100'
       WHEN usd < 1000 THEN 'c. $100 - $1k'
       WHEN usd < 10000 THEN 'd. $1k - $10k'
       WHEN usd < 100000 THEN 'e. $10k - $100k'
       ELSE 'f. > $100k' END AS bucket,
  COUNT(*) AS wallets,
  SUM(usd) AS total_usd,
  SUM(usd) * 100.0 / SUM(SUM(usd)) OVER () AS pct_of_value
FROM bal
GROUP BY 1
ORDER BY 1
