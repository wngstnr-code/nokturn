# Nokturn Threat Model

Translated from the Indonesian original, [threat-model.md](../threat-model.md). The original is the reference if the two ever differ.

> Written at the start, not the end. Design mistakes are the most expensive class of
> bug and **no tool can find them**. Only explicit reasoning can.
>
> Companion documents are `desain-kliring.md`, `desain-auction.md` and `desain-session-engine.md`.

---

## 1. Assets worth attacking

| Asset | Why it is valuable | Exposure |
|---|---|---|
| User funds during `finalize()` | The full value of the batch | **Only inside one atomic transaction** |
| Funds escrowed in the auction | The full value of the auction | 5–10 minutes, from freeze until cross |
| Solver bond | Solver capital | Continuous |
| **Closing print** | **Consumed by other protocols**, so it can trigger liquidations elsewhere | Continuous, and **this is the highest-value asset** |
| Session state | Determines the price band and exposure cap | Continuous |
| Protocol fee | Small | Continuous |

**Key observation.** The most valuable asset is not the funds passing through. It is
the **integrity of the closing print**, because an error in it spreads to the other
protocols that use it to mark collateral. The most profitable attack is not stealing
from Nokturn, but **using Nokturn to steal elsewhere.**

This shapes the whole mitigation priority in this document.

---

## 2. Actors and trust boundaries

| Actor | Trust | Worst it can do |
|---|---|---|
| User | Zero | Send junk intents, intents with no funds |
| Solver | Zero, but **bonded** | Submit bad or invalid solutions. Win and then grief |
| **Coordinator** (intent mempool) | **Semi-trusted** (warning) | Censor intents. Leak intents to a favored solver |
| Owner / governance | Limited, plus 48-hour time-lock | Change the calendar, allowlist and parameters, within hard ranges |
| Guardian | Limited, **no** time-lock | **Pause only.** Cannot move funds |
| Oracle (Chainlink `DualAggregator`) | Trusted with checks | Give a wrong or stale price |
| Onchain market (UniV3 TWAP) | Zero trust, used as the comparison source | Dislocated or manipulated through volume |
| Venue (Uniswap, Arcus, Rialto) | **External code, zero trust** | Reentrancy, false return values |
| Robinhood Chain sequencer | Inherited, outside our control | Reorder, censor |

### 2.1 Deliberate separation of powers

```
Guardian  → instant pause, no time-lock, CANNOT touch funds
Owner     → change parameters, 48-hour time-lock, within hard ranges
Anyone    → NOBODY can move user funds
```

The pattern is that **an emergency stop must be fast, but must be powerless.** A
compromised guardian can only disrupt, not steal. A compromised owner gives 48 hours
to be detected and answered.

#### Installed 19 September 2026, and three things that narrow it

Until that day this section described something that was not yet in the code.
`Guarded` is now inherited by `Settlement` and `AuctionHouse`. Its specification is in
`parameter.md` §8 and its surface is in `interfaces.md` §1.1.

Three things limit it, and all three are in the code, not in policy.

**There is no unpause.** A pause carries a six-hour deadline and lifts itself. The
guardian cannot revoke it, and nobody else needs to. An old line in `parameter.md`
asked the owner to unpause after six hours. It could never be executed, because the
owner is a 48-hour timelock.

**The address is a parameter, not an immutable.** The guardian may pause again as soon
as the previous pause lifts, so a leaked key could hold the protocol down repeatedly.
The ceiling is **48 hours**, which is the time the timelock needs to rotate the
address.

**A pause never touches the exit path.** `refundEscrow` only answers once the auction
is terminal, so a pause that blocked `abortAuction` would trap escrow. A key that can
trap funds is as bad as a key that can move them, and sneakier because it does not
read as theft. The full list is in `parameter.md` §8.2, and `test/Guardian.t.sol` walks
every exit path while paused.

---

## 3. Attack catalog

The **Residual** column is the risk that remains after mitigation. It is written
honestly.

### 3.1 Intent layer

| Attack | Mitigation | Residual |
|---|---|---|
| Cross-chain replay | `chainId` in the EIP-712 domain separator | None |
| Replay on the same chain | Nonce bitmap | None |
| **Intent as a free option** (warning) | A signed, public intent is essentially a free option for the solver. It can wait and include the intent only when that is profitable. Mitigation is a short validity window, session-bound intents, and uniform-price clearing | **Present.** Inherent to every intent-based system, including CoW. Narrowed, cannot be removed |
| Unfunded intents to waste solver time | Solvers check balance and allowance. The auction requires escrow | Small |
| **Censorship by the coordinator** (warning) | A **direct-to-contract submission path** is always available as an escape hatch. It costs more gas, but the coordinator cannot censor it | **Present**, but there is a way out |
| Coordinator leaks intents to a favored solver | The intent mempool is public from the start. If everyone sees it, nobody has a privilege | Small |

### 3.2 Clearing and settlement

| Attack | Mitigation | Residual |
|---|---|---|
| Invalid solution | The verifier rejects it and the bond is slashed | None |
| **Solution copying** (warning) | Solver B sees solver A's solution in the mempool and resubmits it with surplus +1 wei. **There is no commit-reveal in v1.** Mitigation is a short solution window and a bond requirement | **Present and acknowledged.** A v1.1 hardening item. Mention it in the pitch |
| Win and then fail `finalize` (grief) | Slashing, and anyone may call `finalize` | Small. See the 22 September note below, because this row used to be wrong |
| **A user drops the batch after the solution is locked** | `finalize` catches the failed pull, returns what was already pulled, and names the owner through `IntentCollectionFailed` | **Present and acknowledged.** Not a loss of funds, but one transaction can still cancel one batch |
| A lone solver sets any fee it wants | **Hard limit in the contract, at most 20% of savings OR 3 bps of notional** | None |
| Reentrancy through an adapter | Adapter allowlist (time-lock), ReentrancyGuard, and **balance delta measurement** | Small |
| Odd tokens such as fee-on-transfer, rebasing, ERC-777 hooks | **Never trust returned values.** Measure the balance before and after. Per-token vetting before entering the allowlist | Small |
| Harvesting rounding dust | Rounding always favors the contract. The dust invariant is ≥ 0. Dust is swept to the protocol, not to the solver | None |
| `uiMultiplier` changes mid-batch | Read the multiplier at the start and at settle. If it changed, revert the batch for that token | None |
| Stock Token transfer hook fails the transfer | **Resolved 31 July 2026. There is no KYC or jurisdiction gate.** `transfer` and `transferFrom` via Permit2 to a new address succeeded, and every restriction interface probe (ERC-1404, `isBlocked`, `isFrozen`, `isBlacklisted`) reverted. All Stock Tokens share one beacon, so the logic is identical. The `finalize()` design applies as is | **Small.** Two remainders. The token is **Pausable** (`paused()` exists, currently `false`), so check it before clearing. And a blocklist of sanctioned addresses **cannot be proven absent**, so the balance-delta assertion is still mandatory |

### Correction of 22 September 2026, the owner who fails their own pull

The "win and then fail `finalize`" row above used to mention "there is a fallback
solution". **That never existed in `Settlement.sol`.** The contract stores only one
winner, and the solution window is already closed when `finalize` runs, so no second
solution can replace it. The row was wrong from the day it was written, and it is now
fixed.

More important, that row only imagined a solver who deliberately defaults. It did not
imagine the **user** as the attacker at all. Found by Dharu's torture suite, scenarios
C2-20 and C2-21.

The attack is one transaction, run after the solver submits the solution and before
`finalize`.

1. The owner moves their sell balance, or
2. revokes the allowance to Permit2, or
3. burns their nonce through `invalidateUnorderedNonces`.

`_pull` used to have no `try`, so one failed pull canceled the whole batch. After
`FINALIZE_DEADLINE` passed, anyone called `expireBatch`, and `reportFailedFinalize`
seized the bond of a solver who had done nothing wrong. The attacker's cost was one
transaction. The loss to others was one bond plus one batch.

**What changed in the contract.**

`_pull` now wraps the Permit2 call in a `try`. A failed pull does not revert. It
returns everything already pulled to each owner, marks the batch as passthrough, and
emits `IntentCollectionFailed(batchId, owner, intentIndex)`. Nothing is executed and
nothing is seized.

So that the distinction is honest, `submitSolution` now rejects two shapes that are
the solver's own fault. These are a solution built on a nonce that is already spent,
and an intent whose `validUntil` falls inside the solution window. Both are impossible
to pull from the moment the solution is submitted. Without that rejection, a solver
would have a cheap way to avoid slashing by deliberately submitting a solution that is
sure to fail.

**Residual risk, and we do not close it.** An owner can still cancel one batch for
other participants at the cost of one transaction. That is a liveness loss, not a loss
of funds, and the attacker's nonce is burned too. What the contract holds is the
owner's name in the event. Judging who may join the next batch sits with the
coordinator, not the contract, because the contract cannot tell a malicious revocation
from a user who changed their mind.

There is one more side effect. Scenario A10, where the token issuer `pause`s between
submit and finalize, used to revert the batch and seize the solver. It is now also
passthrough. It is the same class, a condition outside the solver's control that
changes after its solution is locked.

Verified in `contracts/test/SettlementCollection.t.sol`, five cases, including that a
solver who truly defaults is still seized.

### 3.3 Auction, the highest-value surface

| Attack | Mitigation | Residual |
|---|---|---|
| Fake imbalance to lure counterparties and then cancel | Escrow from the freeze | None |
| **Closing print manipulation** (warning) | The attacker really trades at a bad price to shift the print, then harvests in a protocol that uses it. That means lending liquidations or, more likely on this chain, settlement of a bet whose size they chose beforehand, see §4. Mitigation is a collar against the oracle, a **minimum volume threshold for publishing a print**, and a challenge mechanism | **Present.** Bounded by the collar width. See §4 |
| Challenge spam | A challenge requires a bond. The reward is paid only on success | None |
| Challenge grief to delay the cross | Fixed challenge window. At most N challenges, then the best one is executed | Small |
| Failed auction, stuck escrow | **The refund path must always be callable**, unconditionally, by anyone. Tested as an invariant | None |

### 3.4 Session engine

| Attack | Mitigation | Residual |
|---|---|---|
| Owner inserts a fake holiday | 48-hour time-lock. A calendar change is always visible long before it takes effect | None |
| Oracle spoofed to look stale | Enters `PROTECTIVE`. Exits only after N healthy updates | Small |
| Sequencer shifts the timestamp | 60-second guard band. Transitions are on a scale of minutes, so a drift of seconds has no effect | None |
| DST table error | Exhaustive testing at every boundary for a decade | None |

### 3.5 Oracle

| Attack | Mitigation | Residual |
|---|---|---|
| **One feed compromised or broken** | **Two independent sources, Chainlink and the Uniswap V3 TWAP.** A gap above 50 bps puts that token in `PROTECTIVE` | Small |
| Both feeds wrong at once | The exposure cap limits the maximum loss | **Present.** Bounded by the cap |
| Stale feed on weekends | Staleness tolerance per session. The band widens but the cap shrinks | None |

> ### Design decision, updated 1 August 2026
> The initial plan used **Chainlink + RedStone**. Onchain verification showed that
> **RedStone does not exist on Robinhood Chain**, and the chain's own documentation
> mentions only Chainlink.
>
> **The replacement is Chainlink versus the Uniswap V3 TWAP**, and this is actually
> stronger. Two oracles of the same category only protect against operational failure.
> **One oracle and one market** protect against both, because the sources are truly
> different. Chainlink comes from off-chain exchange aggregation, and the TWAP comes
> from real onchain transactions.
>
> The disagreement is also meaningful in a specific way. Either the feed is broken or
> stale, **or** the onchain market is dislocated. Both are valid reasons to enter
> `PROTECTIVE`. Disagreement is information.
>
> The added cost is zero, because the Uniswap V3 pool state is **already** read for
> the baseline calculation.

### 3.6 Economics and governance

| Attack | Mitigation | Residual |
|---|---|---|
| Solver cartel submits bad solutions | **Automatic pass-through.** Collusion yields nothing | None |
| Wash trading to harvest rewards | **No token, no emissions.** There is nothing to harvest | None |
| Owner allowlists a malicious adapter | 48-hour time-lock, hard parameter ranges, and the exposure cap | Small |
| Owner key compromised | The time-lock gives 48 hours for detection. The guardian can pause instantly | Small |
| Guardian key compromised | The guardian **can only pause**. It can disrupt but cannot steal | None |

> **A property worth telling the judges.** Because Nokturn **has no token and no
> emissions**, the whole class of farming attacks (wash trading, sybil for rewards,
> mercenary liquidity) has **no surface at all.**

---

## 4. The highest-value attack, analyzed seriously

### Closing print manipulation to trigger liquidations in other protocols

**Why this is the worst.** The value at stake is not the contents of the batch. It is
the collateralized positions in other protocols that use our print to mark value. The
attacker can lose a little in the auction to gain a lot elsewhere.

**The attack path.** Take the opposite side in the closing auction at the worst price
possible within the collar, push the print to the edge of the collar, then liquidate
the positions that became vulnerable because of it.

**Layered mitigations.**

| Layer | Content |
|---|---|
| Collar | The print cannot deviate from the oracle by more than `collarBps`. **This is what bounds the maximum loss** |
| Volume threshold | Below the minimum volume, publish an `insufficient` status, **not a misleading number** |
| Metadata | The print is always published together with the volume and number of participants, so consumers can filter for themselves |
| Challenge | A suboptimal price can be challenged and punished |
| **Consumer guidance** | **Document explicitly that the print is a secondary reference, not a sole oracle** |

**Residual risk, stated plainly.** A sufficiently capitalized attacker **can** shift
the print within the collar by really trading. What we guarantee is the **upper bound
of the deviation**, not that it is impossible.

The last layer, consumer guidance, is the most important and the most often ignored.
Publishing a number that others use to liquidate positions is a responsibility. State
the limits clearly and do not market it as a perfect oracle.

### Updated 10 September 2026. This risk went UP, and we raised it ourselves

Today's decision (`desain-auction.md` §3.3) publishes the closing print through a
**drop-in `AggregatorV3Interface`** surface, so existing consumers can adopt it by
changing one address. The basis is measured. **38 contracts from 24 different
operators, serving 2,048 end users, read an equity price 64,671 times in 10 days**
(queries `8664020` and `8664051`).

**The honest consequence is that this decision raises this risk, not lowers it.** An
adoption cost near zero means the probability of being consumed goes up, and the
probability of being consumed is a multiplier across the whole analysis above.
Lowering the adoption barrier without acknowledging this amounts to moving the risk to
others silently.

**One new mitigation, and it happens to hit the weakest point.**

This attack is cheapest exactly when **participation is thin**. Few counterparties
means little capital is needed to push the print to the edge of the collar. The new
hold semantics close exactly that window.

> When `PRINT_MIN_VOLUME` (1,000 USDG) or `PRINT_MIN_PARTICIPANTS` (5) is not met,
> **no new round is created.** `latestRoundData` keeps returning the last valid print
> with its original, older `updatedAt`. The consumer's own staleness check then
> rejects it.

This means **there is no cheap print to attack.** An auction thin enough to be shifted
cheaply is an auction that produces no number at all. The attacker is forced into
auctions that are already busy, which is exactly when the attack becomes expensive.

Warning. This **narrows** the risk, it does not close it. An attacker willing to
supply their own volume and participants can still pass the gate. What changed is the
price of the entry ticket, and that ticket now has a computable floor. At least 5
distinct addresses and 1,000 USDG of real volume, executed against the collar.

### Updated again 10 September 2026. The attacker profile is not what we thought

The analysis above assumed the payoff path is **liquidation in a lending protocol**.
Measuring the consumer composition (`desain-auction.md` §3.3b) shows that is the
**smallest slice**. Lending has only 20–38 users. The largest is **products that bet
on stock prices**, with `betMsft`, `betUsdg`, `cashOut`, and the event `JackpotFunded`.

**That is a different attack profile, and in one respect a worse one.**

| | Lending liquidation | **Bet settlement** |
|---|---|---|
| Payoff | Limited by the size of the vulnerable position | Limited by the size of the bet, which the attacker can **choose before the print** |
| Timing | The attacker waits for a position to become vulnerable | The attacker **decides** when to bet |
| Direction | Needs the price to move past a threshold | Needs the price to move **to whichever side they bet on** |

An attacker who can choose the size and direction of their bet first, and then shift
the print, has more control than an attacker who waits for a liquidation. **This
raises the mitigation priority, it does not lower it.**

What holds is still the same and still binding. The collar bounds the maximum
deviation, the participation gate closes the cheapest window, and **the consumer
guidance below applies to settlement products exactly as it does to lending**, and
perhaps more.

Warning. **We do not yet know whether any betting product will use the closing
print.** No consumer has committed. This section is a map of the risk **if** adoption
happens, not a claim that it already has.

### Consumer guidance, concrete version

Residual risk #4 says "consumer guidance is published". This is its content, and it
must be published together with the contract addresses, not follow later.

| Rule for consumers | Why |
|---|---|
| **Use it as a second reference, never alone** | The print comes from one daily auction. It is harder to manipulate than an instant spot price, but less frequent. They have different failure modes, so use both |
| **Apply your own staleness check** | We report the real `updatedAt` and never fake it, precisely so your check works. The 30-hour `PRINT_MAX_AGE_ADVISORY` is our recommendation, not our gate |
| **Read the volume and participant metadata before using it** | Available through `INokturnClose`. A print that passes the minimum gate can still be thin. Your threshold may be stricter than ours |
| **Bound the deviation against your primary oracle** | If the print deviates from Chainlink by more than your tolerance, treat it as a signal to stop, not as a price |
| **Do not use it for automatic liquidation without a second layer** | This is the most dangerous use case and the one people are most likely to try. Say so plainly and do not wait for someone to lose first |

---

## 5. Residual risks, an honest summary

This is what you tell the judges without being asked. Presenting it first makes you
look like a builder of production systems. Hiding it and being found out makes you
look like the opposite.

| # | Residual risk | Status |
|---|---|---|
| 1 | **Solution copying between solvers.** There is no commit-reveal in v1 | Acknowledged. v1.1 |
| 2 | **The coordinator is a centralization point** | Acknowledged. The direct onchain path is available as an escape hatch |
| 3 | **The free option problem** on signed intents | Inherent to every intent system. Narrowed, not removed |
| 4 | **The print can be shifted within the collar** | Bounded, not made impossible. Consumer guidance is published |
| 5 | **The code is not audited by a third party** | Compensated by the exposure cap, the seven verification layers, and a bug bounty |
| 6 | **The chain sequencer is outside our control** | Inherited from Robinhood Chain. A liveness feed exists on this chain and we chose **not** to gate on it. The measured reasons are below the table |
| 7 | **A blocklist of sanctioned addresses cannot be proven absent.** The KYC gate is proven absent, but the absence of a blocklist can only be shown negatively from a sample | Narrowed. Balance-delta assertion and `paused()` check |
| 8 | **The Chainlink feed freezes for 48–56 hours every weekend.** The TWAP becomes the main source, and the TWAP can be manipulated through volume | Bounded by `WEEKEND_DRIFT_CAP_BPS` 1,500, exposure cap ×0.5, and `TWAP_WINDOW` 30 minutes |
| 9 | **Nokturn will be the 4th Stylus program on this chain.** Only three have ever been activated, and two of them were called only 1–2 times. There is no Stylus track record on this chain to refer to | The init penalty is measured (46.4k to 49.2k gas) and does not block. The Solidity version remains as the differential oracle, so there is a way back if Stylus has problems |
| 10 | **The regulatory dimension is not mapped.** A Stock Token is legally a *tokenized debt security* issued by Robinhood Assets (Jersey) Ltd, not a share and not a utility token. Running a settlement layer on top of securities, with real users and fee collection, touches territory we have not studied. The token does have a transfer restriction (jurisdiction gate), and it was verified that it does **not** block ordinary `transfer`/`transferFrom`. But the absence of a technical gate is not legal permission | **Not mitigated, scope limited.** During the buildathon there are no third-party users, no fees, and no solicitation. There are only publicly verifiable contracts plus test settlement using our own funds. Legal consultation is mandatory **before** accepting intents from other people. Do not let this become a surprise that comes first from a judge's mouth |
| 11 | **One balance can be sold in many intents (D4).** The coordinator does not reserve balance per owner per token. An owner with 100 USDG can sign twenty intents that each sell 100 USDG, and all are accepted. Measured in torture C2-20, 22 September 2026 | **Fixed in the coordinator, 30 September 2026, at Dharu's request.** At admission, the coordinator sums the balance still held by earlier intents of the same owner on the same token, except those whose nonce is already spent or whose batch passed `solveEnd` without a winner, then rejects an intent that the remainder does not cover. The previous note on this row said "Decided by Dharu, 29 September 2026" not to fix it, and that attribution was wrong. The C2-20 fork test has not been rerun, so this row must not yet be quoted as closed. The limit remains. The coordinator only sees intents that pass through it, and the `submitIntentOnchain` path is not counted |
| 12 | **The solver feed still serves intents whose funds are gone (N3).** A balance, allowance, or nonce that changes after an intent is accepted is not rechecked before the intent enters the solver feed. Measured in torture C2-21 | **Fixed in the coordinator, 30 September 2026, together with D4.** The feed and the status route re-filter the batch against nonce, balance, allowance, and the running total per owner. An intent that drops out is removed from the feed, given status `rejected` with the same code as admission, and reported in the `withdrawn` field. A frozen feed is filtered once, at a block that does not pass `solveEnd`, then shared with all solvers. The residual risk is the window between that filter and `finalize`, which still ends in an unwind without a slash. The C2-21 fork test has not been rerun |
| 13 | **`finalize` can revert if the pool moves between `submitSolution` and `finalize` on a routed solution (W5).** The `minOut` of the venue call is pinned to the baseline quote with no slippage room. Proven on fork on 23 September 2026 (E5). A 150 USDG to NVDA solution, then a 5 USDG swap in the same direction on the same pool, and `finalize` reverts `LiquidityExhausted` in both attempts. The batch stays unfinalized, and after the deadline `expireBatch` slashes an honest solver | **Open. Not safe to claim as closed.** On the fork there are no other traders, so the demo is not affected. On mainnet, with 8.58 million stock token trades per month (August 2026), the same pool almost certainly moves within that window. The contract is immutable and the decision belongs to Wangsit. Sent to Wangsit as a note, 29 September 2026 |


### Why the sequencer liveness feed is not used, measured 21 September 2026

The standard practice on L2s is to refuse to read a price right after the sequencer
recovers, because held transactions execute all at once at a stale price. This chain
has a feed for that, at `0x3cd5824b…`, and we had planned to read it. Measurement
canceled that plan.

| Time | Answer |
|---|---|
| 25 August 07:43 | 1 |
| 25 August 07:54 | 0 |
| 25 August 09:19 | 1 then 0, in the same block |
| 3 September 16:02 | 1 then 0, in the same block |

Six writes in its lifetime, and a live read today answers **1**, with `updatedAt` of 3
September. Eighteen days silent. In Chainlink convention, 1 means the sequencer is
down, so a protocol that gates its prices on this feed would settle not a single batch
today.

It is also not the canonical Sequencer Uptime Feed. `version()` answers 1,
`decimals()` answers 0, and its own name calls it a *keeper heartbeat*. Twice it
flickered 1 then 0 inside a single block, which reads like a test and not an
incident.

So the gate was not installed, and the risk stays open as it is. Gating safety on a
source that behaves like this adds failure surface instead of reducing it. If this
feed later beats regularly and its semantics are documented, this decision will be
reviewed again.

Query `8795706`.

---

## 6. Detection and response

### 6.1 What is monitored

| Signal | Threshold | Action |
|---|---|---|
| Invariant deviates | Even once | **Automatic pause** plus alert |
| Clearing price at the collar edge | 3 times in a row | Alert, investigate |
| Gap between the two oracles | Above the threshold | `PROTECTIVE` for that token |
| Solution fails `finalize` | 2 times in a day | Investigate the solver, consider a slash |
| Auction volume below the minimum | Every occurrence | Mark the print `insufficient` |
| Contract balance deviates from expected | Even once | **Pause** |

Installed 20 September 2026. All six signals above now have code and a place, namely
`M1` to `M7` in `parameter.md` §8.3. The five that can be answered from chain state
are in `contracts/script/MonitorChecks.sol`, and the two that need history are in
`contracts/tools/monitor.py`.

The split is not tidiness. The three checks that call pause, namely `M1`, `M2`, and
`M3`, are all pure functions of the current state, so the pause path does not depend
on a local journal, an indexer, or an archive node. Whatever needs to count events
over time never calls pause.

### 6.2 Incident classification

| Level | Content | Response |
|---|---|---|
| **P0** | Funds at risk, invariant violated | Guardian pauses **immediately**. Announce within 1 hour |
| **P1** | A wrong print was published. Oracle cannot be trusted | `PROTECTIVE`. Notify print consumers |
| **P2** | A solver repeatedly griefs | Slash. Raise the bond requirement through `setMinBond`, ceiling 50,000 USDG |
| **P3** | Anomaly with no funds at risk | Investigate within 24 hours |

The P2 row once promised something that could not be done. Until 20 September 2026,
`MIN_BOND` was a `constant`, so the only way to raise the bond requirement was to
redeploy the immutable core contract. Since the bond became a governed parameter, that
response is actually available, through the 48-hour time-lock like any other parameter
change. The calibration details are in `parameter.md` §5A.

### 6.3 Runbook

Written 19 September 2026, before mainnet and not while an incident is happening. The
five points below used to be a list of things that had to be written. Now they have
content.

#### 1. Guardian key

One `cast wallet` keystore, held by the project owner, with its address recorded in
`deployments/<chain id>.json` and in `.env` as `NOKTURN_GUARDIAN`. It holds no funds,
so losing this key is not losing assets. It is losing the ability to stop.

If the key is lost or leaked, the path is the same, a timelock proposal `setGuardian`
to a new address. It takes 48 hours. During that time the protocol keeps running
normally if the key is lost, or is repeatedly held down if the key leaked.

A 24-hour contact is not a promise one person can make. During the buildathon, scope
is limited to test settlement with our own funds (residual risk number 10), so no
third party depends on response time. **Before accepting intents from other people,
this must become a rotation of more than one person.** Do not let this line still say
"one person" on the first day there is a real user.

#### 2. Pause criteria

Derived from §6.1, and deliberately short so nothing is debated in a panic. **Pause if
any one of these happens.**

- Any invariant deviates, even once
- The contract balance deviates from expected, even once
- A P0 incident according to §6.2, meaning funds at risk

**Do not pause for the rest.** A clearing price at the collar edge, an oracle gap, a
solver that fails `finalize`, and auction volume below the minimum each have their own
more fitting response, and a pause actually obstructs them. Oracle disagreement is
handled by `PROTECTIVE` per token, not by halting the protocol.

If in doubt between pausing and not, **pause**. The cost is six hours and it lifts
itself.

#### 3. Communication templates

Three recipients, three different contents.

**Users.** What stops, what does not, and when it lifts. Say that escrow and refunds
keep working during the pause, because that is the first question that will come up
and the answer is reassuring.

**Print consumers.** Which closing print is affected, and whether it is still valid.
This is the most urgent, because other protocols may use our print as a price and they
need to know before the next liquidation round (§4).

**Integration partners.** The contract addresses touched, the block of the event, and
whether the ABI or parameters changed.

All three are published on the same public channel as the post-mortem, and the first
within one hour for a P0.

#### 4. Recovery procedure

**There is no unpause condition, because there is no unpause.** This point used to ask
for the condition, and that stopped applying as of `parameter.md` §8.1.

What exists is six hours to answer one question, which is whether the cause is gone.
If not, the guardian pauses again. That is a decision repeated every six hours, not
made once at the start.

A fix that needs a parameter or allowlist change goes through the timelock and takes
48 hours, so it will pass through several pause cycles. That is simply its shape. What
cannot be fixed at all is the settlement logic, because the contract is immutable. If
the bug is there, the path is not recovery but halting the protocol until the pause
lifts, announcing, and deploying a new one.

#### 5. Public post-mortem

Mandatory for P0 and P1, within seven days. It contains the timeline, the cause, what
was detected automatically and what was not, and what changes so it does not recur.

It is published as it is, including when the cause was our own mistake.
`pertanyaan-terbuka.md` already records claims that fell and a methodology that was
wrong twice, and that is this repo's strongest asset. A post-mortem that hides the
cause throws that asset away.

---

## 7. Why this document matters for judging

The judging criteria mention *"minimal security vulnerabilities"*. What distinguishes
a project that looks production-ready is not the claim "our code is safe", but the
ability to show:

- **Which asset is the most valuable**, and why it is not the obvious one
- **Trust boundaries that are stated**, not assumed
- **Power that is divided deliberately**, fast but powerless, strong but slow
- **Residual risks acknowledged first**, not after someone else finds them

> *We do not claim this protocol cannot be attacked. We show which attacks are
> possible, how large the loss can be at most, and how we know when it happens.*
