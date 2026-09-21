# Thin delegate so `make fork` works from the repo root, which is what
# docs/pembagian-tugas.md section 3 promises. The real targets live in
# infra/Makefile and are owned by Dharu.

.PHONY: help pin fork deploy fund status prewarm snapshot revert check-fork check-batch check-permit2 api sign-intent postman postman-run postman-resilience postman-api lock clean

help pin fork deploy fund status prewarm snapshot revert check-fork check-batch check-permit2 api sign-intent postman postman-run postman-resilience postman-api lock clean:
	@$(MAKE) -C infra $@ ARGS="$(ARGS)"
