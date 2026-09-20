#!/usr/bin/env bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node
require_fork
[ -f "$FORK_RECORD" ] || die "no $FORK_RECORD. run: make deploy"
node "$INFRA_DIR/scripts/postman.mjs"
node "$INFRA_DIR/scripts/postman-resilience.mjs"
log "import infra/postman/ into Postman, or run: make postman-run"
