# Nokturn Glossary

Translated from the Indonesian original, [glosarium.md](../glosarium.md). The original is the reference if the two ever differ.

> Terms used consistently across all documents and code. If a concept has two
> names, one of them is wrong. Fix it, do not let both live side by side.

---

## Product name

**Nokturn** is one word, capitalized only at the start, **with no "e" at the end**.
The earlier spelling *"Nocturne"* is no longer used (changed 12 August 2026).

| Context | Form |
|---|---|
| Prose, titles, pitch | **Nokturn** |
| Repo directory, package name, SQL column, handle | `nokturn` (lowercase) |
| Solidity contracts and types | Stay descriptive, such as `Settlement` and `SessionManager`. **Do not** prefix them with the product name |

Warning. **The Dune dashboard URL slug stays `nocturne-…`** and **must not be changed**.
Changing it would break seven proof links in the documents. The display text already
reads "Nokturn dashboard". The address is left as it is on purpose.

---

## Protocol core

**Intent** is a signed instruction (EIP-712), not a transaction. It states
*"sell X, receive at least Y, within this time limit"*. Signing is free. Funds
stay in the user's wallet until settlement. **Not** an "order".

**Batch** is a set of intents settled together at one uniform clearing price.
Its length is set by the session and the flow rate.

**Solver** is a permissionless party that computes clearing solutions and competes to
win the batch. Bonded. It does not need to be trusted, because the contract verifies its solution.

**Solution** is a solver's proposal. It holds the price per token, the execution per intent,
the venue calls, and the savings claim.

**Clearing price** is one price per token per batch. Every
participant in the batch executes at this price. No discrimination by ordering.

**Netting** *(coincidence of wants)* is the part of the volume where buyers and sellers
cover each other directly, without touching a venue. Zero spread, zero pool fee, zero MEV.

**Routing** is the remaining imbalance that was not netted, sent to an external venue
as one **aggregate order**.

**Order (venue)** is **used, and only for this**. It is the call Nokturn
sends to an external venue (a Uniswap V3 swap). There it really is an order in the
venue's own sense, and calling it an "intent" would be wrong, because venues do not accept
intents.

> **The rule runs one way.** What **comes into** Nokturn is an **intent**. What
> **goes out** to a venue is an **order**. The boundary is the routing point. If a sentence
> uses "order" for something the user signs, it is wrong. This is not
> a matter of taste.

Legitimate derived forms are *aggregate order*, *one large order*, and *routing order*.
Still forbidden are *"user order"* and *"order book"*.

**Pass-through** is the safe mode. If the best solution does not beat the venue
baseline, each intent is routed directly and **there is no fee at all**.

---

## Measurement

**Baseline** is how much the user would actually receive by executing
alone on the best venue, at that size, in that same block. **Computed from pool
state** (`slot0`, `liquidity`, `fee`) using Uniswap math, and **not** through a
`staticcall` to the Quoter, which is impossible because the Quoter tries an `SSTORE`.
**Not** the limit price, **not** the oracle mid price.

**Savings** is `received − baselineReceived`. The **same number** is used to
pay the solver, compute the protocol fee, and claim results to the public.
One metric, no double story.

**Netting ratio** is the share of volume that cancels internally. It measures whether
the network effect is starting to work.

---

## Session and time

**Session** is a real-world market state. The values are `OPEN`, `PRE_MARKET`,
`POST_MARKET`, `CLOSED_OVERNIGHT`, `CLOSED_WEEKEND`, `HOLIDAY`, `AUCTION_OPEN`,
`AUCTION_CLOSE`, and `PROTECTIVE`. It sets the batch duration, price band, and exposure cap.

**Off-hours** is all time outside `OPEN`. It is Nokturn's main product session.
**74.1% of equity trades and 65.2% of volume happen here** (August 2026).

**`PROTECTIVE`** is a safe mode **per token** (not per chain) when oracle evidence
contradicts the calendar. This covers a halt, a stale feed, or two oracles disagreeing.
Bands are tightened, caps are lowered, and the auction never runs.

**Guard band** is 60 seconds around every session boundary. Inside it there is no new
batch and no cross. The parameters used are the **more conservative** ones of the two
adjoining sessions.

**Early close** is a day when the exchange closes at 13:00 ET instead of 16:00. These are the day
after Thanksgiving, Christmas Eve, and 3 July. It shifts the closing auction schedule.

---

## Auction

**Opening cross / closing cross** are the opening and closing auctions. Four phases.
Accumulation → indicative disclosure → freeze → cross.

**Indicative price** is the estimated clearing price published every block during the
disclosure window, together with the size and direction of the imbalance.

**Imbalance** is the difference between demand and supply at the indicative price.
Publishing it is an **open invitation to liquidity**. The mechanism
turns unknown risk into measurable opportunity.

**Freeze** is the cancellation deadline. After it, auction intents cannot be withdrawn
and their funds are escrowed, so the imbalance figure is guaranteed to be real.

**Collar** is the limit on how far the auction price may deviate from the oracle reference. It widens
step by step during an extension. Different from the **price band**, which applies to ordinary batches.

**Closing print** is the canonical daily closing price produced by the closing auction,
formed from real onchain supply and demand. It is a **public good**. Other
protocols consume it to mark collateral. It is published with `sufficient` status only if it
passes the volume and participant-count thresholds.

---

## Intent types

**SPOT** is an ordinary batch intent.
**MOO** is *Market-on-Open*. It executes at whatever the auction clearing price is.
**LOO** is *Limit-on-Open*. It executes only if the clearing price is within an **absolute** limit.
**ROO** is *Reference-on-Open*. Its limit is **relative to the opening reference price**,
for example "no worse than 50 bps from the opening reference price". It is for people
who sign on Saturday and do not know the fair price on Monday.

**Opening reference price** is the Chainlink feed TWAP over the first 5 minutes of the
`OPEN` session according to our SessionManager calendar. Warning. It is **not** the exchange's
official opening price, which is not available onchain. Never call it "official".
**Batch-TWAP** is one signature, with execution spread across N consecutive batches.

---

## Agent

**Mandate** is the onchain limit on an agent's authority. It covers the assets it may
touch, the maximum notional, the permitted sessions, and the **maximum deviation from
fair price**. An intent outside the mandate never executes. This is not because the agent
obeys but because the contract rejects it.

**Solver scoreboard** is a reputation derived **entirely from onchain settlement
facts**, not self-reported reviews. Sybils are useless.

---

## Governance and security

**Guardian** can pause **instantly with no time-lock**, cannot unpause, and
**cannot touch funds**. Fast but powerless.

**Owner** can change parameters, the allowlist, and the calendar through a **48-hour
time-lock**, within hard ranges embedded in the contract. Strong but slow.

**Exposure cap** is a notional limit per batch, per token per day, and global per
day. It makes the maximum loss a **calculated number, not a hoped-for one**.
This is what makes the early mainnet safe even though it is unaudited.

**Time-lock** is 48 hours for all parameter changes. Enough to detect a
compromised owner key.

---

## Terms deliberately NOT used

| Do not | Use | Reason |
|---|---|---|
| "Order", **for the user's intention** | **Intent** | Order implies something resting on a book. An intent is a signed intention. Warning. This ban does **not** apply to calls to a venue. See "Order (venue)" in the Protocol core section |
| "Slippage protection" | **Limit** + **price band** | Two different mechanisms with different guarantees. Merging them blurs both |
| "MEV protection" | **Netting** + **uniform price** | We remove the surface. We do not "protect" against something that stays |
| "Oracle price" (for a clearing result) | **Clearing price** vs **reference price** | Clearing is produced by the market. The reference comes from an oracle. Confusing the two is dangerous |
| "APY" / "yield" | None | Nokturn is not a yield product. It saves cost and does not generate returns |
| "Token" / "points" / "airdrop" | None | A conscious decision. There are none. See `distribusi.md` §6 |
