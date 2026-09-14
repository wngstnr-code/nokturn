-- Nokturn — Stylus activity cross-check (ArbWasm precompile + EF-prefixed code)
-- Two independent checks for any Stylus usage on Robinhood Chain: contracts with
-- EOF prefix 0xEF, and any trace calling the ArbWasm precompile 0x...0071
-- (activateProgram lives there).
-- Dune query id: 8194528  (superseded 8176xxx/8180xxx on the retired passchick team)
-- Visualization: table
--
-- METHODOLOGY LESSON, published deliberately. Verified 2026-08-02:
--   1,946,537 contracts deployed
--           0 with 0xEF prefix   <- the naive check, and it is WRONG
--           9 ArbWasm traces / 3 distinct activation tx  <- the correct check
--           0 ArbWasmCache traces  <- no cache manager on this chain
-- Absence of data in one view is not evidence of absence of activity.

WITH ef_code AS (
    SELECT count(*) AS n
    FROM robinhood.creation_traces
    WHERE block_month >= DATE '2026-06-01'
      AND bytearray_substring(code, 1, 1) = 0xef
),
arbwasm_calls AS (
    SELECT count(*) AS n, count(DISTINCT tx_hash) AS n_tx, min(block_time) AS first_seen, max(block_time) AS last_seen
    FROM robinhood.traces
    WHERE block_date >= DATE '2026-06-01'
      AND to = 0x0000000000000000000000000000000000000071
),
arbwasmcache_calls AS (
    SELECT count(*) AS n
    FROM robinhood.traces
    WHERE block_date >= DATE '2026-06-01'
      AND to = 0x0000000000000000000000000000000000000072
),
total AS (
    SELECT count(*) AS n FROM robinhood.creation_traces WHERE block_month >= DATE '2026-06-01'
)
SELECT
    (SELECT n FROM total)                 AS total_contracts_deployed,
    (SELECT n FROM ef_code)               AS contracts_with_ef_prefix,
    (SELECT n FROM arbwasm_calls)         AS arbwasm_precompile_traces,
    (SELECT n_tx FROM arbwasm_calls)      AS arbwasm_distinct_tx,
    (SELECT first_seen FROM arbwasm_calls) AS arbwasm_first_seen,
    (SELECT last_seen FROM arbwasm_calls)  AS arbwasm_last_seen,
    (SELECT n FROM arbwasmcache_calls)    AS arbwasmcache_precompile_traces
