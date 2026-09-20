# Thin delegate so `make fork` works from the repo root, which is what
# docs/pembagian-tugas.md section 3 promises. The real targets live in
# infra/Makefile and are owned by Dharu.

.PHONY: help pin fork deploy fund status prewarm snapshot revert check-batch postman postman-run postman-resilience lock clean

help pin fork deploy fund status prewarm snapshot revert check-batch postman postman-run postman-resilience lock clean:
	@$(MAKE) -C infra $@
