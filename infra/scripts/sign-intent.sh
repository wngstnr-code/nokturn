#!/usr/bin/env bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node
require_fork
[ -f "$FORK_RECORD" ] || die "no $FORK_RECORD. run: make deploy"
[ -f "$INFRA_DIR/chain.json" ] || "$INFRA_DIR/scripts/extract-addresses.sh"
exec node "$INFRA_DIR/scripts/sign-intent.mjs" "$@"
