#!/usr/bin/env bash
#
# Drives one batch through Nokturn, end to end, on the fork the backend already
# runs on.
#
# It does not start anvil and it does not deploy. Those are make fork, make deploy
# and make fund in infra, and the reason this script gave them up is that it used
# to make a second fork of its own at a different block. Both would have been
# right about a different chain state, so the receipt on the demo screen would not
# have been the receipt the coordinator produced for the same intent.
#
#   make fork      in one terminal, stays in the foreground
#   make deploy
#   make fund
#   tools/fork-demo.sh
#
# The demo runs in a closed session on purpose. That is where the Chainlink feeds
# are frozen and the price has to come from the pool instead, and the weekend
# alone carries 33.2 percent of this chain's trades. Anything that works only
# while the feeds are live is not the thing worth showing.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# infra/scripts/lib.sh owns where the fork answers and what the deployment record
# is called. Reading it here rather than restating it is the whole point.
# shellcheck disable=SC1091
. "$REPO/infra/scripts/lib.sh"
require_cmd forge cast node
load_env
load_accounts
require_fork

[ -f "$FORK_RECORD" ] || die "no $FORK_RECORD. run: make deploy"

CHAIN="$(cast chain-id --rpc-url "$FORK_RPC")"
[ "$CHAIN" = "4663" ] || die "fork reports chain id $CHAIN, expected 4663"

SESSIONS="$(json_get "$FORK_RECORD" sessions)"
FORK_BLOCK="$(pinned_block)"

run() {
  ( cd "$CONTRACTS_DIR" && forge script "script/demo/ForkDemo.s.sol:ForkDemo" \
      --rpc-url "$FORK_RPC" --broadcast --unlocked --sender "$DEPLOYER" "$@" >/dev/null )
}

warp_to() {
  # Mine an empty block at the target time before the script runs. Forge simulates
  # against the latest block, so a timestamp that only arrived with the broadcast
  # would make every window check fail in simulation and never reach the chain.
  cast rpc --rpc-url "$FORK_RPC" evm_setNextBlockTimestamp "$1" >/dev/null
  cast rpc --rpc-url "$FORK_RPC" evm_mine >/dev/null
}

# The shared fork mines on a timer, and Settlement.SOLUTION_WINDOW is ten seconds.
# A forge script needs longer than that to check its artifacts, simulate and then
# broadcast, so the window closes between the warp and the transaction and submit
# reverts with SolutionWindowClosed. Measured on the fork, 21 September 2026.
#
# So the timer is switched off for the length of the demo and the node mines on
# each transaction instead. The clock then only moves where this script moves it.
# It is put back on the way out, including when a stage fails, because the backend
# is on the far side of the same node.
#
# Both calls are needed and the order matters. Clearing the interval also clears
# automine, so a node told to automine first and then given a zero interval stops
# mining altogether, and every later transaction hangs rather than reverting.
BLOCK_TIME="${NOKTURN_FORK_BLOCK_TIME:-1}"
thaw() { cast rpc --rpc-url "$FORK_RPC" evm_setIntervalMining "$BLOCK_TIME" >/dev/null 2>&1 || true; }
trap thaw EXIT
cast rpc --rpc-url "$FORK_RPC" evm_setIntervalMining 0 >/dev/null
cast rpc --rpc-url "$FORK_RPC" evm_setAutomine true >/dev/null

# cast prints "1790019000 [1.79e9]" and shell arithmetic chokes on the second half.
callnum() {
  cast call --rpc-url "$FORK_RPC" "$@" | awk '{print $1}'
}

log "fork is at pinned block $FORK_BLOCK, sessions at $SESSIONS"

# The batch time is not written down. It is found from the chain, because a fork
# cannot advance an external feed. Warping to a fixed Saturday days out leaves
# every Chainlink round days old, and the quote asset is checked against the wall
# clock in every session, so the whole batch fails on a feed that is perfectly
# healthy in reality. So walk forward to the NEAREST session that can settle,
# which is tonight when run on a weekday and right now when run at the weekend.
#
# CLOSED_WEEKEND is 6 and CLOSED_OVERNIGHT is 0. Walk the real boundaries rather
# than bisecting, because Friday evening and Saturday evening are both closed and
# a bisection would step straight over the transition between them.
NOW="$(cast block latest --rpc-url "$FORK_RPC" --field timestamp | awk '{print $1}')"
CURSOR=$((NOW + 120))
BATCH=""
for _ in $(seq 1 12); do
  S="$(callnum "$SESSIONS" "sessionAt(uint64)(uint8)" "$CURSOR")"
  if [ "$S" = "6" ] || [ "$S" = "0" ]; then
    DUR="$(callnum "$SESSIONS" "batchDuration(uint8)(uint32)" "$S")"
    # Step well inside the session so neither edge lands in the guard band, then
    # down to a boundary. A boundary that is not a multiple of the session's own
    # duration is refused, and the duration differs per session.
    MID=$((CURSOR + 1800))
    BATCH=$(( (MID / DUR) * DUR ))
    NAME="$([ "$S" = "6" ] && echo CLOSED_WEEKEND || echo CLOSED_OVERNIGHT)"
    break
  fi
  CURSOR="$(callnum "$SESSIONS" "nextTransition(uint64)(uint64)" "$CURSOR")"
  CURSOR=$((CURSOR + 60))
done
[ -n "$BATCH" ] || die "no closed session found within twelve transitions of the fork clock"

log "$NAME at $BATCH, $(( (BATCH - NOW) / 3600 )) hours ahead of the fork clock"

warp_to $((BATCH - 600))
log "checking the fork is funded"
run --sig 'prepare()'

log "batch $BATCH, netted against the pool"
warp_to $((BATCH + 2))
run --sig 'submit(uint64,bool)' "$BATCH" false
warp_to $((BATCH + 12))
run --sig 'finalize(uint64,bool)' "$BATCH" false

# The second screen. Two intents on the same side, so there is nothing to net and
# the whole volume goes to the venue in one call. Each intent gets its share of
# what the venue returned, which means the saving is not small, it is zero, and
# Settlement says so itself rather than being told.
#
# Ten batches later so the first one is long finalized, and still a multiple of the
# session's own duration, which is what batch alignment is checked against.
BATCH_ROUTED=$((BATCH + 10 * DUR))
S2="$(callnum "$SESSIONS" "sessionAt(uint64)(uint8)" "$BATCH_ROUTED")"
[ "$S2" = "$S" ] || die "the routed batch at $BATCH_ROUTED fell out of session $S into $S2"

log "batch $BATCH_ROUTED, both intents on the same side, routed to the pool"
warp_to $((BATCH_ROUTED + 2))
run --sig 'submit(uint64,bool)' "$BATCH_ROUTED" true
warp_to $((BATCH_ROUTED + 12))
run --sig 'finalize(uint64,bool)' "$BATCH_ROUTED" true

log "writing the record the screens read"
run --sig 'report(uint64,uint64)' "$BATCH" "$BATCH_ROUTED"
cat "$CONTRACTS_DIR/deployments/demo.json"
echo
