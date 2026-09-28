#!/usr/bin/env bash
# Thin wrapper. The work is in extract-addresses.mjs, because a regex that has to
# survive both bash quoting and a JS string literal is a regex nobody can read.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node

node "$INFRA_DIR/scripts/extract-addresses.mjs" \
  "$CONTRACTS_DIR/script/Addresses.sol" \
  "$INFRA_DIR/chain.json"

log "wrote $INFRA_DIR/chain.json"
