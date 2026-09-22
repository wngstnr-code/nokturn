#!/usr/bin/env bash
# Starts the reference solver against the fork and the coordinator API.
#
#   make solver                      runs as a service until stopped
#   make solver ARGS="--duration 10" exits on its own after ten chain minutes
#
# The solver refuses to start unless solverA is bonded, funded and bare, and
# names the command that fixes it, so this script only checks what it needs to
# find the solver at all.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node
require_fork
[ -f "$FORK_RECORD" ] || die "no $FORK_RECORD. run: make deploy"
[ -d "$REPO_ROOT/solver/node_modules" ] || die "run: pnpm install --dir solver"
curl -sf "${NOKTURN_API_URL:-http://127.0.0.1:3000}/v1/health" >/dev/null || die "no api answering. run: make api"

log "starting the solver $*"
cd "$REPO_ROOT" && exec node solver/src/index.ts --run "$@"
