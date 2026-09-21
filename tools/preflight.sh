#!/usr/bin/env bash
#
# Every gate in .github/workflows/contracts.yml that runs in under a minute on a
# laptop, in one command, so a push does not discover them one at a time.
#
# It exists because two of these were missed on consecutive pushes. The gas
# snapshot and the storage layout are both committed files that a contract change
# makes stale, and neither failure says anything until CI has already gone red.
#
# What it leaves out is what needs a cluster or a long run, which is slither,
# aderyn, halmos, echidna, mutation, the deep suites and the stylus differential.
# Those stay in CI where they belong.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

fail=0
step() {
  printf '\n\033[1;36m==>\033[0m %s\n' "$1"
  shift
  if "$@"; then
    return 0
  fi
  printf '\033[1;31mxxx\033[0m that gate failed\n' >&2
  fail=1
}

cd "$REPO/contracts"

step "formatting" forge fmt --check
step "build" forge build
step "tests, without the fork suite" forge test --no-match-path "test/fork/*"
step "gas snapshot" env FOUNDRY_PROFILE=default forge snapshot --check --force --no-match-path "test/fork/*"
step "the guardian has exactly one power" python3 tools/guardian-gate.py

printf '\n\033[1;36m==>\033[0m storage layout\n'
bash tools/storage-layout.sh >/dev/null
if ! git -C "$REPO" diff --exit-code contracts/storage-layout.txt >/dev/null; then
  printf '\033[1;31mxxx\033[0m storage-layout.txt is stale, it has been regenerated for you\n' >&2
  fail=1
fi

printf '\033[1;36m==>\033[0m shared abi\n'
bash tools/export-abi.sh >/dev/null
if ! git -C "$REPO" diff --exit-code packages/shared/abi >/dev/null; then
  printf '\033[1;31mxxx\033[0m the shared abi is stale, it has been regenerated for you\n' >&2
  fail=1
fi

cd "$REPO"
step "prose" python3 tools/prose-gate.py

if [ "$fail" -ne 0 ]; then
  printf '\n\033[1;31mxxx\033[0m at least one gate failed. Nothing was pushed.\n' >&2
  exit 1
fi

printf '\n\033[1;36m==>\033[0m every fast gate passed\n'
