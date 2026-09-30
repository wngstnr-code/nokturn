# Backend infrastructure. Owned by Dharu, docs/pembagian-tugas.md section 3.
# Run from the repo root as `make <target>`, which delegates here.

SHELL := /usr/bin/env bash
S     := ./scripts

.PHONY: help pin fork deploy fund status prewarm snapshot revert check-fork check-batch check-permit2 api solver sign-intent postman postman-run postman-resilience postman-api torture torture-soak lock clean

help:
	@echo "pin          measure the head and write infra/pinned-block.json"
	@echo "fork         start anvil against the pinned block, foreground"
	@echo "deploy       run Deploy, Bootstrap and SetFeeds against the fork"
	@echo "fund         move tokens from real holders to the demo accounts"
	@echo "status       one screen of what the fork currently says"
	@echo "prewarm      pull the state the demo reads into the fork cache"
	@echo "api          start the coordinator api, foreground"
	@echo "solver       start the reference solver, ARGS=\"--duration 10\" bounds it"
	@echo "sign-intent  sign and submit one intent, or run a negative --case"
	@echo "check-fork   durability suite for the fork everything stands on"
	@echo "check-batch  differential check of the batchId helper against the chain"
	@echo "check-permit2  prove the witness digest is the one Permit2 verifies"
	@echo "snapshot     take an evm_snapshot, the reset that works on a fork"
	@echo "revert       roll back to that snapshot and take a fresh one"
	@echo "postman      regenerate infra/postman from the live deployment"
	@echo "postman-run  run the chain checks headless with newman"
	@echo "postman-resilience  run the clock and session break tests"
	@echo "postman-api  regenerate and run the api surface tests"
	@echo "torture      worst case suite for the coordinator, GROUP=c2 for one group"
	@echo "torture-soak the two hour soak, run it in the background"
	@echo "lock         raise the timelock delay to 48h, opt in, freezes parameters"
	@echo "up           the whole stack in docker, fork to solvers, waits until healthy"
	@echo "demo         one batch end to end through the stack make up started"
	@echo "logs         follow every service of the stack"
	@echo "down         remove every container and volume the stack made"
	@echo "clean        remove the fork deployment record and the snapshot id"
	@echo "db-up        start the indexer postgres on 127.0.0.1:5440"
	@echo "db-down      stop it, keeping the data"
	@echo "db-reset     delete its volume, asks first"
	@echo "indexer      start the event indexer, ARGS=\"--duration 10\" bounds it"
	@echo "demo-fail    one failure receipt, CASE=passthrough|expired|unwound"
	@echo "demo-compete solverA against solverB, ARGS=\"--batches 3\" or \"--same-side\""
	@echo "expire       expireBatch from another account, BATCH=<batchId>"
	@echo "replay       play the august fixture through the live stack, ARGS=\"--duration 5\" required"
	@echo "keeper-fork  a fork inside a closing session with the clock frozen, deployed and funded, foreground"
	@echo "keeper       run the auction keeper, ARGS=\"--duration 10\" bounds it in chain minutes"

.PHONY: db-up db-down db-reset indexer demo-fail demo-compete expire replay up down logs demo keeper-fork keeper rpc-proxy mainnet-api mainnet-indexer check-batch-mainnet

keeper-fork:
	@$(S)/keeper-fork.sh

keeper:
	@node ../solver/src/keeper.ts $(ARGS)

# The official mainnet RPC on 127.0.0.1:8547, reached by address rather than by
# DNS. For the indexer and the api on mainnet, see scripts/rpc-proxy.mjs.
rpc-proxy:
	@node scripts/rpc-proxy.mjs $(ARGS)

# The api and the indexer on mainnet 4663, read only. Needs make rpc-proxy.
mainnet-api:
	@$(S)/mainnet.sh api $(ARGS)

mainnet-indexer:
	@$(S)/mainnet.sh indexer $(ARGS)

check-batch-mainnet:
	@$(S)/mainnet.sh check-batch

up:
	@$(S)/stack.sh up

down:
	@$(S)/stack.sh down

logs:
	@$(S)/stack.sh logs

demo:
	@node $(S)/demo.mjs

# ARGS="--duration 5" plays five chain minutes at speed 1. A faster speed is refused,
# because the fixture is cut into windows as long as one fork batch.
# Needs make api, make solver and make indexer running.
replay:
	@node ../analytics/src/replay.ts $(ARGS)

# solverA against solverB on one batch. ARGS="--batches 3" or "--same-side".
# Stop make solver first.
demo-compete:
	@node $(S)/demo-compete.mjs $(ARGS)

# CASE is passthrough, expired or unwound. Stop make solver first.
demo-fail:
	@node $(S)/demo-fail.mjs --case $(CASE)

expire:
	@node $(S)/expire.mjs $(BATCH)

indexer:
	@$(S)/indexer.sh $(ARGS)

db-up:
	@$(S)/db.sh up

db-down:
	@$(S)/db.sh down

db-reset:
	@$(S)/db.sh reset

pin:
	@$(S)/pin-block.sh

fork:
	@$(S)/fork.sh

prewarm:
	@$(S)/prewarm.sh

deploy:
	@$(S)/deploy.sh

fund:
	@$(S)/fund.sh

status:
	@$(S)/status.sh

api:
	@$(S)/api.sh

solver:
	@$(S)/solver.sh $(ARGS)

sign-intent:
	@$(S)/sign-intent.sh $(ARGS)

check-fork:
	@$(S)/check-fork.sh

check-batch:
	@$(S)/check-batch.sh

check-permit2:
	@$(S)/check-permit2.sh

snapshot:
	@$(S)/snapshot.sh

revert:
	@$(S)/revert.sh

postman:
	@$(S)/postman.sh

postman-resilience:
	@pnpm dlx newman run postman/nokturn-resilience.postman_collection.json \
		--reporters cli --reporter-cli-no-banner

# Regenerated on every run. The collection is ignored and per laptop, and a copy
# that outlived a redeploy signs for the old Settlement. D17.
postman-api:
	@node $(S)/postman-api.mjs
	@pnpm dlx newman run postman/nokturn-api.postman_collection.json \
		--reporters cli --reporter-cli-no-banner

postman-run:
	@pnpm dlx newman run postman/nokturn-fork.postman_collection.json \
		-e postman/nokturn-local.postman_environment.json \
		--reporters cli --reporter-cli-no-banner

torture:
	@$(S)/torture.sh $(GROUP)

torture-soak:
	@$(S)/torture.sh soak

lock:
	@$(S)/lock.sh

clean:
	@rm -f fork-deployment.json .snapshot-id
	@echo "removed the fork deployment record and the snapshot id"
