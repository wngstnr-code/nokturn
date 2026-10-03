# Nokturn

Intent based batch settlement for tokenized equities on Robinhood Chain.

Most trading in tokenized equities on this chain happens while the underlying
market is closed, when there is no official reference price. Nokturn collects
signed intents over a window sized to the market session, matches opposing flow
at one clearing price, routes only the residual to Uniswap V3, and publishes the
venue baseline next to every execution so anyone can recompute it from pool state
at the same block. If a batch cannot beat that baseline, it settles at the venue
price and charges no fee.

**[Try it on testnet](https://app.testnet.nokturn.xyz)** ·
**[Mainnet app](https://app.nokturn.xyz)** ·
**[Website](https://nokturn.xyz)** ·
**[Technical report](https://drive.google.com/drive/folders/11-DkCsKXMJsj-1Jb4owT-TWUeg_9kd0Y?usp=drive_link)** ·
**[Market data on Dune](https://dune.com/passchick/nokturn-robinhood-chain-equity-market-structure-august-2026)**
<!-- Demo video. Replace DEMO_VIDEO_URL and move this line up into the row above.
**[Demo video](DEMO_VIDEO_URL)** ·
-->

## Try it in three minutes

The testnet runs the whole flow, from a signature in your wallet to a settled
batch on chain. Its tokens are test tokens, and its prices follow the Chainlink
feeds on mainnet, checked for a new round every minute.

1. Add Robinhood Chain Testnet to your wallet. Chain ID `46630`, RPC
   `https://rpc.testnet.chain.robinhood.com`, currency ETH.
2. Open [app.testnet.nokturn.xyz/trade](https://app.testnet.nokturn.xyz/trade) and
   connect. Press **Get test tokens**. The faucet sends a little ETH for gas,
   10,000 tQUOTE and 10 of each stock token. You need nothing to start.
3. Sell 1 tNVDA. Your wallet asks for one Permit2 approval, the only transaction
   you send, and then one signature. The signature is the intent. Nothing leaves
   your wallet until the batch clears.
4. Wait for the batch to close. A batch lasts 10 seconds while NYSE is open, 30
   seconds in pre-market and after-hours, 45 seconds overnight and 60 seconds on
   weekends.
5. Open **Batches** and read the receipt. It shows how the batch ended, what you
   received next to your share of the venue baseline, and the transactions that
   settled it.

If two people sell and buy in the same batch, they are matched with each other
directly and nothing goes to the pool.

## The problem, measured

All figures come from our own public Dune queries over indexed Robinhood Chain
data for August 2026.

| | August 2026 |
|---|---|
| Stock token trades | 8.58M |
| Stock token volume | $1,005.6M |
| Active wallets | 139,093 |
| Trades while NYSE was closed | 74.1% |
| Volume while NYSE was closed | 65.2% |
| Weekend trades | 33.2% |

Off-hours execution is not uniformly worse. It is worse in the tail. At p90, price
movement between trades in weekday off-hours was 1.27x the open session. At p99 it
was 8.50x, 1,779 bps against 209 bps. Off-hours flow is occasionally very badly
priced, and there is no reference price to tell when.

Replaying real August 2026 trades through the batching mechanism gives 27 to 33
percent netting at a realistic early share of 10 to 20 percent of flow, and 50.1
percent at full flow once bot round trips are excluded. These are backtests. The
trades are real and the mechanism is hypothetical for that month, because Nokturn
did not exist yet. The SQL for every query is mirrored in `data/dune-queries/`.

## How it works

```
 wallet signs intent (Permit2 witness, no gas)
        │
        ▼
 coordinator API ── collects intents for one batch window, sized per session
        │
        ▼
 solver ── nets buyers against sellers at one clearing price
        │   routes only the residual to Uniswap V3
        ▼
 Settlement contract
   ├─ checks every limit, the price band and the oracle for the session
   ├─ pulls funds through Permit2, pays out, routes the residual
   └─ emits the result next to the venue baseline computed from pool state
        │
        ▼
 indexer ── batch receipts any reader can check against the chain
```

The session engine is what makes this specific to equities. Batch length, price
band, exposure caps and the price source all change with the real market state,
including daylight saving, holidays, early closes and per token halts. On weekends
the Chainlink feeds freeze for 48 to 56 hours, so the oracle switches to a 30
minute pool TWAP anchored to the Friday close, with a drift cap of 1,500 bps.

Solvers post a 500 USDG bond. A failed finalize costs 10 percent of it and a
misreported surplus costs 25 percent.

## Deployments

| | Mainnet 4663 | Testnet 46630 |
|---|---|---|
| Contracts | Deployed 29 September 2026, verified on Sourcify | Deployed 3 October 2026 |
| Settlement | [`0x92075BaA…3cb934`](https://robinhoodchain.blockscout.com/address/0x92075BaA431Cb3A4CeaD3F6E676d26F6c0bCb934) | [`0xe1FF85BC…60e607`](https://explorer.testnet.chain.robinhood.com/address/0xe1FF85BCBaf11C2540a623BE3Ee2846f0a60e607) |
| Tokens | Real Stock Tokens NVDA, AAPL, TSLA, GOOGL, GME and USDG | Test tokens tNVDA, tAAPL, tTSLA, tGOOGL, tGME and tQUOTE |
| Prices | Chainlink feeds, live since the 48 hour time-lock executed on 1 October 2026 | Mainnet Chainlink rounds, mirrored as they land |
| Venue | Real Uniswap V3 pools | Test pools with liquidity copied from the mainnet pools |
| Solver | **None bonded yet**, so no batch has settled on mainnet | Running, with a keeper for the session auctions |
| Batches settled | 0 | Routed and netted batches, from the app |

Every address is in `contracts/deployments/`. On mainnet the app reads live
sessions, oracle prices and baseline quotes from real pools, and it does not offer
to sign while no solver is bonded, because nothing would fill the intent. A
netted testnet batch, `1791035640`, settled in
[submit](https://explorer.testnet.chain.robinhood.com/tx/0x05f1d8cf778067b97805512bcd78c4663c11fbf2888d0dd76f0149d915a91117)
and
[finalize](https://explorer.testnet.chain.robinhood.com/tx/0xad5a849c1905eac638d9e4fe734e21a7254e4fa310790f020d0afd4984b2478b).
Testnet balances and flow are synthetic, so no netting or savings figure from
testnet is quoted anywhere as evidence.

## Security and testing

The settlement core is immutable, with no proxy. Only the allowlist and parameters
change, through a 48 hour time-lock. No key can move user funds, and that is meant
to be checked by reading the code rather than by trusting this sentence.

| Gate | When it runs |
|---|---|
| 431 unit, fuzz and integration tests | Every push |
| Slither and Aderyn, zero high findings | Every push |
| Line coverage of at least 95 percent on core contracts | Every push |
| Committed gas snapshot | Every push |
| Fork tests against mainnet, zero difference from the pool quote | Nightly |
| Deep invariant runs, differential tests against a Rust verifier | Nightly |
| Halmos symbolic proofs of the clearing and rounding math | Nightly |
| Echidna on the same invariants | Nightly |

The [threat model](docs/en/threat-model.md) lists the assets, the trust
boundaries, the attack catalogue and thirteen residual risks. The ones we state
first:

- Intents pass through a single coordinator. It is a point of centralization.
  Anyone can publish their own intent on chain through the escape hatch, which the
  app shows next to every waiting intent.
- Solver solutions are not commit-reveal. A short solution window and the bond
  limit the damage.
- A routed finalize can revert if the pool moves between submit and finalize. This
  one is not closed.
- The comparison against the dominant aggregator router is an off-chain metric
  with an open method, not an on-chain guarantee. The on-chain baseline is Uniswap
  V3 pool state.
- No third party has audited the code yet.

## Scope of v1.0

The code assumes no particular token. What it trades is gated by an allowlist
that changes through the time-lock. The launch allowlist is NVDA, AAPL, TSLA, GOOGL
and GME, chosen on volume, oracle cadence and weekend liquidity together. SPCX is
excluded permanently because it has no feed.

Uniswap V3 is the only venue in v1.0. The dominant V4 pools use a dynamic fee hook,
so their baseline cannot be computed from state, and a baseline nobody can
recompute is not a baseline. The adapter is factory agnostic, because two other
venues on this chain proved byte identical to Uniswap V3 when we called them.

## Repository layout

```
contracts/          Foundry project
  src/              Settlement, SessionManager, ClearingVerifier, PriceOracle,
                    SolverRegistry, AuctionHouse, ClosingPrintFeed,
                    AgentMandate, MandateAccount, Guarded
  src/adapters/     UniswapV3Adapter, the only venue in v1.0
  script/           Deploy, Bootstrap, Lock, SetFeeds, VerifyDeployment,
                    and the testnet fixtures and price mirror
  test/             Unit, fuzz, invariant, fork, Halmos and Echidna suites
  deployments/      Deployed addresses, 4663 mainnet and 46630 testnet
  tools/            Price mirror, smoke run, proof and coverage gates
api/                Intent coordinator, Fastify, REST and WebSocket
solver/             Reference solver, recovery and the auction keeper
indexer/            Event indexer into PostgreSQL, serves batch receipts
packages/shared/    ABIs and API types shared by the backend and the app
app/                Next.js website and trading app
analytics/          Replay of real August 2026 trades for the netting backtest
verifier/           Rust clearing verifier and the differential harness
infra/              Docker Compose, mainnet fork, deploy and relayer images
data/               Dune SQL mirrors and the NYSE session calendar
docs/               Design documents, with English versions in docs/en/
tools/              Repository gates
```

## Built with

| Layer | Stack |
|---|---|
| Smart contracts | Solidity 0.8.28, Foundry 1.8.3, OpenZeppelin Contracts 5.7.0, Permit2, Uniswap V3, Chainlink Data Feeds |
| Backend | Node.js 22, TypeScript, Fastify 5, viem 2, PostgreSQL 18, pnpm |
| Frontend | Next.js 15, React 19, wagmi 2, viem 2 |
| Verification | Rust with revm for the differential verifier, Slither, Aderyn, Echidna, Halmos |
| Operations | Anvil mainnet fork, Docker Compose, GitHub Actions, Railway, Vercel |
| Data | Dune, over indexed Robinhood Chain tables |

## Documentation

- [Docs index](docs/en/README.md), a map of every design document
- [Glossary](docs/en/glossary.md)
- [Threat model](docs/en/threat-model.md)
- [Technical report](https://drive.google.com/drive/folders/11-DkCsKXMJsj-1Jb4owT-TWUeg_9kd0Y?usp=drive_link)

The design documents under `docs/` were written in Indonesian during the research
phase in August and early September 2026. They are published as written, including
the places where an earlier conclusion was measured and thrown away.

## Team Nokturn

Built for the Arbitrum Open House Singapore Buildathon.

| Member | Role |
|---|---|
| Wangsit Nursyahada | Smart contracts |
| Dharu Bintang Mahendratama | Backend |
| Nabil Aufa Danaputra | Frontend |

## License

MIT.
