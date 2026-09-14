-- Nokturn — stock token universe (paired vs canonical USDG)
-- Identify stock token addresses and volumes traded against canonical USDG, July 2026.
-- Dune query id: 8194525  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: table — volume_usd as progressbar
--
-- Note the TWO separate GME rows this returns:
--   0x1b0e319c6a659f002271b69db8a7df2f911c153e — genuine Stock Token
--   0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba3 — memecoin impersonator (~$29.6M)
-- Any figure that sums them is overstated by roughly 30%. Never group by symbol.

WITH legs AS (
    SELECT block_time, amount_usd,
           token_bought_address AS tok, token_bought_symbol AS sym
    FROM dex.trades
    WHERE blockchain = 'robinhood' AND block_month = DATE '2026-07-01'
      AND token_sold_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
    UNION ALL
    SELECT block_time, amount_usd,
           token_sold_address AS tok, token_sold_symbol AS sym
    FROM dex.trades
    WHERE blockchain = 'robinhood' AND block_month = DATE '2026-07-01'
      AND token_bought_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
)
SELECT sym, tok,
       count(*) AS n_trades,
       round(sum(amount_usd)) AS volume_usd,
       round(approx_percentile(amount_usd, 0.5), 2) AS median_trade_usd
FROM legs
GROUP BY 1, 2
ORDER BY volume_usd DESC
LIMIT 30
