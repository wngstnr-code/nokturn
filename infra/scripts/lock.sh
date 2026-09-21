#!/usr/bin/env bash
# Raises the timelock delay to 48 hours on the fork. Opt in, and not part of
# `make deploy`, because after this nothing else can be configured without two
# days of chain time and the demo still needs parameters to move.
#
# Worth running once before submission to prove the step works, on a throwaway
# fork rather than the one the demo runs on.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd forge node
load_accounts
require_fork

[ -f "$FORK_RECORD" ] || die "no $FORK_RECORD. run: make deploy"
warn "after this the fork freezes every parameter for 48h of chain time"
cp "$FORK_RECORD" "$CHAIN_RECORD"
( cd "$CONTRACTS_DIR" && forge script script/Lock.s.sol:Lock \
    --rpc-url "$FORK_RPC" --unlocked --sender "$PROPOSER" --broadcast )
rm -f "$CHAIN_RECORD"
log "delay raised"
