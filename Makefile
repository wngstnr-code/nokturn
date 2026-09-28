# Thin delegate so `make fork` works from the repo root, which is what
# docs/pembagian-tugas.md section 3 promises. The real targets live in
# infra/Makefile and are owned by Dharu.

TARGETS := help pin fork deploy fund status prewarm snapshot revert check-fork check-batch check-permit2 api solver sign-intent postman postman-run postman-resilience postman-api torture torture-soak lock clean db-up db-down db-reset indexer demo-fail demo-compete expire replay up down logs demo

.PHONY: $(TARGETS)

$(TARGETS):
	@"$(MAKE)" -C infra $@ ARGS="$(ARGS)" CASE="$(CASE)" BATCH="$(BATCH)" GROUP="$(GROUP)"
