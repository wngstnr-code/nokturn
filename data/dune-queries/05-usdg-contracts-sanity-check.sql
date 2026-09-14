-- Robinhood Chain — USDG contracts sanity check
-- Identify canonical USDG contract and decimals before measuring holders.
-- Canonical: 0x5fc5360d0400a0fd4f2af552add042d716f1d168, 6 decimals.
-- Impersonators use 18 decimals — getting this wrong is a factor of 1e12.
-- Dune query id: 8194507  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: table — transfers as progressbar

SELECT e.contract_address, e.symbol, e.name, e.decimals, COUNT(t.evt_tx_hash) AS transfers
FROM tokens.erc20 e
LEFT JOIN erc20_robinhood.evt_transfer t ON t.contract_address = e.contract_address
WHERE e.blockchain = 'robinhood' AND UPPER(e.symbol) LIKE '%USDG%'
GROUP BY 1, 2, 3, 4
ORDER BY transfers DESC
LIMIT 10
