# Coordinator client

The seam between the app and the intent coordinator. The schema is frozen and it
belongs to the backend, `docs/pembagian-tugas.md` section 1 item 3. The source of
truth is `packages/shared/api-types.ts` on the `dharu/intent-coordinator` branch.
`types.ts` here is a mirror of the slice the screens read, and it goes away the
day that branch lands on main.

## Routes this app calls

| Route | Method | Used by |
|---|---|---|
| `/v1/health` | GET | The empty state, to say why it is empty |
| `/v1/batches/current` | GET | Chain time and the collect window, before signing |
| `/v1/nonces/:owner` | GET | The Permit2 nonce, before signing |
| `/v1/intents` | POST | Submit a signed intent |
| `/v1/intents/:intentHash` | GET | One intent's status and its escape hatch |

There is no list by owner. Nothing on the frozen surface answers "every intent
this address has open", so a screen that wants one tracks the hashes it submitted
and asks about each.

## What the owner signs

Not an Intent. `Settlement._pull` calls `permit2.permitWitnessTransferFrom`, so
the only digest anything verifies is a Permit2 `PermitWitnessTransferFrom` whose
witness is the Intent. `lib/permit2.ts` builds it, and it refuses to sign at all
unless Permit2's own `DOMAIN_SEPARATOR` and Settlement's `WITNESS_TYPE_STRING`,
both read from the chain, agree with what this app would produce. A digest that
is merely close fails with nothing saying why, so it fails closed instead.

Neither value is hardcoded. Permit2 rebuilds its separator when the chain id is
not the one it was deployed on, and Settlement sits at a different address on the
fork, on 46630 and on mainnet.

## Two things the app deliberately does not do

It does not compute the venue baseline. A third implementation of
`quoteFromState` alongside the adapter and the solver would be a third answer to
a number the whole project rests on.

It does not invent data when the endpoint is missing. Every failure arrives as
`ApiError` with a code and a reason, and that reason reaches the screen instead
of a status number.

## Pointing it at a running coordinator

The API defaults to `127.0.0.1:3000` and it owns that port, so this app runs on
3001. Start the fork and the API from the repo root, then set the variable.

```
make fork      # own terminal, stays foreground
make deploy
make fund
make api       # second terminal
```

```
NEXT_PUBLIC_COORDINATOR_URL=http://127.0.0.1:3000 pnpm dev
```

CORS is already open on the API, so nothing is needed on this side for it.
`WS /v1/stream` lives at `ws://127.0.0.1:3000/v1/stream` and is not wired up here
yet.
