#!/usr/bin/env bash
# A fork standing inside a closing session, for the auction keeper and its
# tests. Same block and the same frozen clock as tools/fork-auction.sh, for the
# reason that script gives: a weekend fork warped to a weekday close finds every
# feed stale and nothing crosses (N17). It stops after deploy and fund, so the
# keeper does the auction rather than Wangsit's scripted one.
#
#   make keeper-fork        then, in another terminal
#   pnpm -C solver test:fork -- --test-name-pattern K
#
# It writes the same infra/fork-deployment.json as make fork, so the two take
# turns rather than run together.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd anvil cast forge node
load_env
load_accounts

BLOCK="${NOKTURN_KEEPER_BLOCK:-66491729}"
fork_is_up && die "something already answers at $FORK_RPC. stop the batch fork first, because both write $FORK_RECORD"

MNEMONIC="${NOKTURN_FORK_MNEMONIC:-$(json_get "$ACCOUNTS_FILE" _mnemonic)}"
LOG="$INFRA_DIR/.torture/keeper-anvil.log"
mkdir -p "$INFRA_DIR/.torture"

log "forking $(redact_url "$NOKTURN_RPC_MAINNET") at block $BLOCK"
anvil --host 127.0.0.1 --port "${NOKTURN_FORK_PORT:-8545}" --chain-id 4663 \
  --mnemonic "$MNEMONIC" --auto-impersonate \
  --fork-url "$NOKTURN_RPC_MAINNET" --fork-block-number "$BLOCK" >"$LOG" 2>&1 &
ANVIL_PID=$!
# EXIT too, or a deploy that dies leaves anvil holding the port.
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT INT TERM
wait_for_fork 90

# forge asks eth_feeHistory over the last ten blocks before it broadcasts. On a
# fresh fork that range reaches below the fork block, anvil forwards it, and the
# upstream answers "metadata is not found". make fork never meets this because
# its block time has mined past ten blocks by the time deploy runs. Measured
# 30 September 2026 against Alchemy.
cast rpc --rpc-url "$FORK_RPC" anvil_mine 12 >/dev/null

# Frozen, so the minutes deploy and fund take do not walk the chain out of the
# closing session. Time then only moves where a test warps it.
cast rpc --rpc-url "$FORK_RPC" anvil_setBlockTimestampInterval 0 >/dev/null

bash "$INFRA_DIR/scripts/deploy.sh"
bash "$INFRA_DIR/scripts/fund.sh"

SESSION="$(cast call "$(json_get "$FORK_RECORD" sessions)" "currentSession()(uint8)" --rpc-url "$FORK_RPC")"
[ "$SESSION" = "4" ] || die "the fork left the closing session during setup, currentSession is $SESSION"
log "closing session fork ready at block $BLOCK, anvil pid $ANVIL_PID, log $LOG"
wait "$ANVIL_PID"
