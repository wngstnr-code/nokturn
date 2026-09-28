#!/usr/bin/env bash
# Rolls the fork back to the last snapshot. A snapshot id is consumed by the
# revert, so a new one is taken straight away and the id file stays usable.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd cast
require_fork

[ -f "$INFRA_DIR/.snapshot-id" ] || die "no snapshot taken. run: make snapshot"
ID="$(cat "$INFRA_DIR/.snapshot-id")"
OK="$(cast rpc evm_revert "$ID" --rpc-url "$FORK_RPC" | tr -d '"')"
[ "$OK" = "true" ] || die "revert to $ID refused, the snapshot was already consumed"
NEW="$(cast rpc evm_snapshot --rpc-url "$FORK_RPC" | tr -d '"')"
echo "$NEW" > "$INFRA_DIR/.snapshot-id"
log "reverted to $ID, new snapshot $NEW"
