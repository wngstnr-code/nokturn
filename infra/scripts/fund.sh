#!/usr/bin/env bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node
require_fork
[ -f "$INFRA_DIR/chain.json" ] || "$INFRA_DIR/scripts/extract-addresses.sh"
exec node "$INFRA_DIR/scripts/fund.mjs"
