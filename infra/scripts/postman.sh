#!/usr/bin/env bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node
require_fork
[ -f "$FORK_RECORD" ] || die "no $FORK_RECORD. run: make deploy"
node "$INFRA_DIR/scripts/postman.mjs"
node "$INFRA_DIR/scripts/postman-resilience.mjs"
if curl -sf "${NOKTURN_API_URL:-http://127.0.0.1:3000}/v1/health" >/dev/null 2>&1; then
  node "$INFRA_DIR/scripts/postman-api.mjs"
else
  warn "api is not answering, skipped the api collection. start it with make api"
fi
log "import infra/postman/ into Postman, or run: make postman-run"
