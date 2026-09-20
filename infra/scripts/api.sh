#!/usr/bin/env bash
# Starts the coordinator API against whichever chain NOKTURN_API_RPC points at.
#
# The fork has to be up and deployed first, because the API resolves its chain
# once at boot and refuses to start without a deployment record. A server that
# starts anyway would answer every request with a five hundred while looking
# healthy to whoever started it.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node
require_fork
[ -f "$FORK_RECORD" ] || die "no $FORK_RECORD. run: make deploy"
[ -f "$INFRA_DIR/chain.json" ] || "$INFRA_DIR/scripts/extract-addresses.sh"
[ -d "$REPO_ROOT/api/node_modules" ] || die "run: pnpm install --dir api"

log "starting the api on \${NOKTURN_API_PORT:-3000}"
cd "$REPO_ROOT/api" && exec node src/index.ts
