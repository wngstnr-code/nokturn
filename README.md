# Nokturn

Intent-based settlement for tokenized equities on Robinhood Chain.

Most trading in tokenized equities on this chain happens while the underlying
market is closed. In August 2026, 74.1 percent of stock token trades and 65.2
percent of volume landed outside NYSE hours, and 33.2 percent of trades happened
on weekends. During those hours there is no official reference price, and the
tail of execution quality is where the damage sits.

Nokturn collects signed intents, batches them over a fixed window sized per market
session, matches opposing flow directly at a single clearing price, routes only
the residual imbalance to a venue, and publishes the venue baseline next to every
execution so anyone can recompute it from pool state at the same block.

## Status

Design is complete and implementation started on 14 September 2026, the first day
the buildathon Code of Conduct allows code. Nothing is deployed yet. This README
describes what is being built, not what is running.

The design documents in `docs/` are the working record from the research phase
that ran through August and early September 2026. They are published as written,
including the parts where earlier conclusions were measured and thrown away.

## The measured problem

All figures below come from our own Dune queries against indexed Robinhood Chain
data, covering August 2026 unless noted.

| | July 2026 | August 2026 |
|---|---|---|
| Stock token trades | 3.66M | 8.58M |
| Stock token volume | $280.2M | $1,005.6M |
| Active wallets | 59,785 | 139,093 |
| Trades while NYSE closed | 65.6% | 74.1% |
| Volume while NYSE closed | 56.4% | 65.2% |
| Weekend trades | 12.9% | 33.2% |

Execution quality did not get uniformly worse off-hours. It got worse in the tail.
Between July and August the p90 gap between off-hours and open-session price
movement nearly closed, falling from 2.47x to 1.27x. Over the same period the p99
ratio moved the other way, from 1.22x to 8.50x. Off-hours flow is not generally
badly priced. It is occasionally very badly priced, with no reference price
available to tell the difference at the time.

## What is verifiable today

Nine Dune queries, all permanent and public, assembled into one dashboard.

[Nokturn, Robinhood Chain equity market structure, August 2026](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026)

Query IDs are 8595234, 8595239, 8595244, 8595247, 8595251, 8595303, 8595357,
8595365, and 8595386. A further three run against September data, with IDs
8663760, 8663787, and 8663798. The SQL for each is mirrored in `data/dune-queries/`.

The NYSE session calendar the contracts depend on is in `data/nyse-calendar/`,
generated rather than hand-entered, with DST boundaries broken out separately.

## Netting is a backtest, and it is labeled that way everywhere

Replaying real August 2026 flow through the batching mechanism gives 63.8 percent
gross netting at full flow and 50.1 percent once bot round-trips are excluded. At
a realistic early market share of 10 to 20 percent the figure is 27 to 33 percent.

These are counterfactual simulations over real trade inputs. The inputs are real,
the mechanism is hypothetical, because Nokturn did not exist in August. We write
backtest, never measured. The interesting result is not any single number but the
curve, which runs from 21.4 percent netting at 5 percent share to 50.1 percent at
full share. That shape is a network effect that can be checked rather than
asserted.

## Scope of v1.0

The code is general and does not assume particular tokens. Exposure is gated by an
allowlist that grows through a 48 hour time-lock, not by narrowing the code.

Launch allowlist is NVDA, AAPL, TSLA, and GOOGL, chosen on volume, oracle feed
cadence, and weekend liquidity together rather than volume alone. GME and SPY are
held back because their feeds update too rarely. SPCX is permanently excluded
because it has no feed at all.

Uniswap V3 is the only venue adapter in v1.0. Dominant V4 pools use a dynamic fee
hook, which means the baseline cannot be computed from pool state, and a baseline
we cannot recompute is a baseline nobody can check. V4 arrives in v1.1 through the
allowlist, not through a redeploy. The adapter is written factory-agnostic, because
two other concentrated liquidity venues on this chain turned out to be byte
identical to Uniswap V3 when we called their contracts directly.

## Limits we state up front

The settlement core is immutable with no proxy. Only the allowlist and parameters
can change, through a 48 hour time-lock. No key can move user funds, and that is
meant to be verifiable by reading the code rather than by trusting this paragraph.

Known gaps in v1.0, all deliberate:

- The intent mempool runs through a single coordinator. This is a centralization
  point and we are not going to pretend otherwise.
- Solver solutions are not commit-reveal. Mitigation for now is a short solution
  window plus bonding.
- The exchange calendar is owner-controlled behind the time-lock.
- Comparison against the dominant aggregator router is an off-chain published
  metric with open methodology, not an on-chain guarantee. That router cannot be
  quoted on-chain. The on-chain baseline is Uniswap V3 pool state.

Ten residual risks are listed openly in `docs/threat-model.md`.

## Repository layout

```
contracts/     Foundry. Settlement, SessionManager, SolverRegistry,
               AuctionHouse, AgentMandate, PriceOracle, adapters
verifier/      Stylus. Rust clearing verifier, pending a benchmark
               against the Solidity implementation
solver/        TypeScript reference solver and intent coordinator
app/           Next.js
analytics/     Dune queries and backtest scripts
data/          Dune SQL mirrors and the NYSE session calendar
docs/          Design documents and the research record
```

## Chain

Mainnet is Robinhood Chain 4663. Testnet is 46630.

Testnet has no stock tokens, no canonical USDG, and no Uniswap V3 pools. We
verified this directly. That means testnet cannot be used to prove any number,
because anything running there sits on top of tokens and pools we filled
ourselves. Testnet carries the end to end flow and the UI. Anything numeric runs
against a mainnet fork with real pools, real tokens, and real prices.

## Team

Wangsit on contracts, Dharu on backend, Nabil on frontend. Built for the Arbitrum
Open House Singapore Buildathon.

## License

MIT.
