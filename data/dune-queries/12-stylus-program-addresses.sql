-- Nokturn — Stylus program addresses (from activateProgram calldata)
-- Extract the program addresses passed to ArbWasm.activateProgram on Robinhood Chain.
-- Selector activateProgram(address) = 0x58c780c2
-- Dune query id: 8194531  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: table — activation_gas as progressbar; input/output hidden
--
-- Verified 2026-08-02: exactly 3 programs, all activated by 0xb00beed0...
--   2026-07-25  0xabce50d4038d9cfa6bc85ff8768d7b1e8149b2e5  7,732,596 gas
--   2026-07-29  0x5e6eda74cc2abea0de3a322337993b9bf1de9654  7,779,040 gas
--   2026-07-30  0xcc049d1dede2aa33c18312cc37af914e954d6eda  8,175,905 gas
-- Nokturn would be the 4th Stylus program ever activated on this chain.

SELECT
    block_time,
    tx_hash,
    tx_from,
    input,
    bytearray_substring(input, 17, 20) AS program_address,
    output,
    gas_used AS activation_gas
FROM robinhood.traces
WHERE block_date BETWEEN DATE '2026-07-25' AND DATE '2026-07-31'
  AND to = 0x0000000000000000000000000000000000000071
  AND bytearray_substring(input, 1, 4) = 0x58c780c2
ORDER BY block_time
