# Nokturn documentation

Nokturn is an intent based settlement layer for tokenized equities on Robinhood
Chain. It collects signed intents over a window sized to the market session, matches
opposing flow at one clearing price, routes only the residual to a venue, and
publishes the venue baseline next to every execution.

For what is deployed and running today, start with the repository
[README](../../README.md). This page is a map of the design documents behind it.

## In English

| Document | What it covers |
|---|---|
| [Glossary](glossary.md) | What intent, batch, session and the other terms mean here, including the words we deliberately avoid |
| [Threat model](threat-model.md) | Assets, trust boundaries, the attack catalogue, and every risk that remains, listed openly |

## The research and design archive, in Indonesian

The team wrote its working documents in Indonesian from August to early September
2026, before the code. They are published as written, including the places where
an earlier conclusion was measured and thrown away. The English versions above are
translations, and the Indonesian original is the reference if the two ever differ.

| Document | What it covers |
|---|---|
| [ide-utama.md](../ide-utama.md) | The idea, the data behind it, and the ideas we dropped with the reason for each |
| [pitch.md](../pitch.md) | The claims we make, and the claims an audit of competitors ruled out |
| [demo.md](../demo.md) | The demo surfaces and where each number on them comes from |
| [desain-session-engine.md](../desain-session-engine.md) | The session engine. Daylight saving, holidays, early closes, halts, and the weekend feed freeze |
| [desain-auction.md](../desain-auction.md) | Opening and closing auctions at the session boundary, and the closing print |
| [desain-kliring.md](../desain-kliring.md) | The uniform price clearing math, with proofs |
| [desain-baseline.md](../desain-baseline.md) | How the venue baseline is computed from Uniswap V3 pool state |
| [desain-agent.md](../desain-agent.md) | Agents as intent senders and as solvers, and the mandate contract |
| [desain-ekonomi.md](../desain-ekonomi.md) | The baseline guarantee, fee bounds and revenue |
| [distribusi.md](../distribusi.md) | Distribution, cold start, and why there is no token |
| [spek-teknis.md](../spek-teknis.md) | Architecture, scope and the seven verification layers |
| [parameter.md](../parameter.md) | The single source of truth for every constant |
| [interfaces.md](../interfaces.md) | Contract interfaces, events, errors and the indexer data model |
| [rencana-uji.md](../rencana-uji.md) | The test plan. Invariants, differential tests, Halmos, mutation testing |
| [pertanyaan-terbuka.md](../pertanyaan-terbuka.md) | Onchain verification results, including the measurements that proved us wrong |
| [runbook-deploy.md](../runbook-deploy.md) | How the contracts were deployed to mainnet and testnet |
| [runbook-backend.md](../runbook-backend.md) | How the API, indexer, solver and relayer are run |
| [brand.md](../brand.md) | The visual identity |

## The data

Every market figure we quote comes from our own public Dune queries, collected in
one dashboard,
[Nokturn, Robinhood Chain equity market structure (August 2026)](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026).
The netting figures there are a backtest over real August 2026 trades. The
mechanism is hypothetical for that month, because Nokturn did not exist yet.
