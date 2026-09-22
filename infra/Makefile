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
	@echo "clean        remove the fork deployment record and the snapshot id"
	@echo "db-up        start the indexer postgres on 127.0.0.1:5433"
	@echo "db-down      stop it, keeping the data"
	@echo "db-reset     delete its volume, asks first"
	@echo "indexer      start the event indexer, ARGS=\"--duration 10\" bounds it"

.PHONY: db-up db-down db-reset indexer

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
