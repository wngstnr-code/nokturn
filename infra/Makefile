# Backend infrastructure. Owned by Dharu, docs/pembagian-tugas.md section 3.
# Run from the repo root as `make <target>`, which delegates here.

SHELL := /usr/bin/env bash
S     := ./scripts

.PHONY: help pin fork deploy fund status prewarm snapshot revert postman postman-run lock clean

help:
	@echo "pin          measure the head and write infra/pinned-block.json"
	@echo "fork         start anvil against the pinned block, foreground"
	@echo "deploy       run Deploy, Bootstrap and SetFeeds against the fork"
	@echo "fund         move tokens from real holders to the demo accounts"
	@echo "status       one screen of what the fork currently says"
	@echo "prewarm      pull the state the demo reads into the fork cache"
	@echo "snapshot     take an evm_snapshot, the reset that works on a fork"
	@echo "revert       roll back to that snapshot and take a fresh one"
	@echo "postman      regenerate infra/postman from the live deployment"
	@echo "postman-run  run that collection headless with newman"
	@echo "lock         raise the timelock delay to 48h, opt in, freezes parameters"
	@echo "clean        remove the fork deployment record and the snapshot id"

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

snapshot:
	@$(S)/snapshot.sh

revert:
	@$(S)/revert.sh

postman:
	@$(S)/postman.sh

postman-run:
	@pnpm dlx newman run postman/nokturn-fork.postman_collection.json \
		-e postman/nokturn-local.postman_environment.json \
		--reporters cli --reporter-cli-no-banner

lock:
	@$(S)/lock.sh

clean:
	@rm -f fork-deployment.json .snapshot-id
	@echo "removed the fork deployment record and the snapshot id"
