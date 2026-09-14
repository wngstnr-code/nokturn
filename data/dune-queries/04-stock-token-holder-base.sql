-- Robinhood Chain — Stock token holder base and concentration
-- Is there a real holder base to sell a holder-oriented product to?
-- Dune query id: 8194496  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: column — x=bucket, y_left=wallets (0,0), y_right=total_usd ($0.0a)
--
-- WARNING: this query has NO date filter. Balances are cumulative all-time and
-- drift upward over time. Do not present its output as a July 2026 snapshot.

WITH stock AS (
  SELECT DISTINCT output_0 AS addr FROM robinhood_robinhood.stockfactory_call_deploy WHERE call_success
),
flows AS (
  SELECT t."to" AS wallet, t.contract_address AS ca, CAST(t.value AS double) / 1e18 AS amt
  FROM erc20_robinhood.evt_transfer t JOIN stock s ON t.contract_address = s.addr
  UNION ALL
  SELECT t."from", t.contract_address, -CAST(t.value AS double) / 1e18
  FROM erc20_robinhood.evt_transfer t JOIN stock s ON t.contract_address = s.addr
),
bal AS (
  SELECT wallet, ca, SUM(amt) AS balance
  FROM flows
  WHERE wallet <> 0x0000000000000000000000000000000000000000
  GROUP BY 1, 2
  HAVING SUM(amt) > 0
),
px AS (
  SELECT contract_address, price FROM prices_dex.latest WHERE blockchain = 'robinhood'
),
v AS (
  SELECT b.wallet, SUM(b.balance * COALESCE(p.price, 0)) AS usd
  FROM bal b LEFT JOIN px p ON b.ca = p.contract_address
  GROUP BY 1
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
FROM v
WHERE usd > 0
GROUP BY 1
ORDER BY 1
