#!/usr/bin/env bash
# Runs the worst case suite for the intent coordinator, then writes
# infra/torture-report.md from what each group recorded.
#
# Only against a fork. Every group snapshots and reverts, and the API under test
# is a private one on 3100, so a coordinator somebody is running on 3000 is left
# alone. docs/rencana-uji-terburuk-coordinator.md is the plan this implements.
#
#   torture.sh           every group except the soak
#   torture.sh c2        one group, by file prefix
#   torture.sh soak      the two hour soak

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node
require_fork
[ -f "$FORK_RECORD" ] || die "no $FORK_RECORD. run: make deploy"
[ -f "$INFRA_DIR/chain.json" ] || "$INFRA_DIR/scripts/extract-addresses.sh"
[ -d "$REPO_ROOT/api/node_modules" ] || die "run: pnpm install --dir api"

cd "$INFRA_DIR"
DIR=scripts/torture
GROUP="${1:-}"

if [ "$GROUP" = "soak" ]; then
  FILES=("$DIR/s-soak.test.mjs")
elif [ -n "$GROUP" ]; then
  shopt -s nullglob
  FILES=("$DIR/$GROUP"-*.test.mjs)
  [ ${#FILES[@]} -gt 0 ] || die "no group named $GROUP under $DIR"
else
  FILES=()
  for f in c0-shared c1-mempool c2-submit c3-read c4-tooling h-http r-rpc l-load f9-lifecycle f10-stream; do
    FILES+=("$DIR/$f.test.mjs")
  done
fi

status=0
node --test --test-concurrency=1 "${FILES[@]}" || status=$?
node "$DIR/report.mjs"
exit "$status"
