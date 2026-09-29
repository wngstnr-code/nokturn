#!/usr/bin/env bash
# Starts the event indexer against the fork and the compose Postgres.
#
#   make indexer                          runs as a service until stopped
#   make indexer ARGS="--duration 10"     exits on its own after ten chain minutes
#   make indexer ARGS="--until-block N"   exits once block N is indexed

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node
require_fork
[ -f "$FORK_RECORD" ] || die "no $FORK_RECORD. run: make deploy"
[ -d "$REPO_ROOT/indexer/node_modules" ] || die "run: pnpm install --dir indexer"

log "starting the indexer $*"
cd "$REPO_ROOT" && exec node indexer/src/index.ts "$@"
