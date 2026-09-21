#!/usr/bin/env bash
#
# The closing cross for NVDA, on a fork of mainnet 4663.
#
# This is the one screen that cannot share the batch demo's fork, and the reason is
# measured rather than assumed. A closing auction only exists in the half hour
# before the bell. The batch demo stands in the weekend on purpose, because that is
# where the feeds are frozen, and the nearest closing session ahead of that pin is
# thirty hours away. NVDA's open session staleness bound is 19,000 seconds and the
# weekend pin is already 131,777 seconds past the last feed write, so warping a
# weekend fork forward to the next close leaves the oracle answering unhealthy and
# nothing crosses.
#
# So this fork stands at its own block, and everything else is shared. The deploy
# and the funding are infra's own scripts, unchanged, and the accounts are the same
# five people the coordinator knows.
#
# Block 66,491,729 is Friday 18 September 2026 at 19:56:20 UTC. That is inside the
# closing session, which runs 19:30 to 20:00 UTC, and it sits 48 seconds after the
# last feed write before the bell. Measured 21 September 2026.
#
#   tools/fork-auction.sh
#
# Run it with nothing else on the port. The batch fork and this one write the same
# deployment record, so they take turns rather than run together.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# shellcheck disable=SC1091
. "$REPO/infra/scripts/lib.sh"
require_cmd anvil forge cast node
load_env
load_accounts

AUCTION_BLOCK="${NOKTURN_DEMO_AUCTION_BLOCK:-66491729}"
CROSS_AT=1789761600

if fork_is_up; then
  die "something already answers at $FORK_RPC. stop the batch fork first, because both write $FORK_RECORD"
fi

MNEMONIC="${NOKTURN_FORK_MNEMONIC:-$(json_get "$ACCOUNTS_FILE" _mnemonic)}"
LOG="${TMPDIR:-/tmp}/nokturn-auction-anvil.log"

# No block timer. The batch demo turns one off for the length of its run, and there
# is no reason to switch one on here only to switch it back off.
log "forking $NOKTURN_RPC_MAINNET at block $AUCTION_BLOCK"
nohup anvil --host 127.0.0.1 --port "${NOKTURN_FORK_PORT:-8545}" --chain-id 4663 \
  --mnemonic "$MNEMONIC" --auto-impersonate \
  --fork-url "$NOKTURN_RPC_MAINNET" --fork-block-number "$AUCTION_BLOCK" >"$LOG" 2>&1 &
ANVIL_PID=$!
disown "$ANVIL_PID" 2>/dev/null || true
wait_for_fork 90

# The clock is frozen for the whole run, and without this nothing else works. A
# forked anvil moves its block timestamps with the laptop's own clock, so the
# deploy and the funding spend real minutes and the chain walks straight out of the
# closing session before a single intent is committed. Measured on the first run,
# which reached 20:03 chain time and was refused by the session check.
#
# With the interval at zero, a block carries its parent's timestamp and the clock
# only moves where this script moves it. It is left frozen at the end on purpose,
# so the screens can be read for as long as anyone wants without the fork drifting
# past the cross it is showing.
cast rpc --rpc-url "$FORK_RPC" anvil_setBlockTimestampInterval 0 >/dev/null

warp_to() {
  cast rpc --rpc-url "$FORK_RPC" evm_setNextBlockTimestamp "$1" >/dev/null
  cast rpc --rpc-url "$FORK_RPC" evm_mine >/dev/null
}

run() {
  ( cd "$CONTRACTS_DIR" && forge script "script/demo/ForkAuction.s.sol:ForkAuction" \
      --rpc-url "$FORK_RPC" --broadcast --unlocked --sender "$DEPLOYER" "$@" >/dev/null )
}

bash "$INFRA_DIR/scripts/deploy.sh"
bash "$INFRA_DIR/scripts/fund.sh"

# A known point inside the closing session, which the frozen clock has held us at
# anyway. Warping here rather than assuming it makes the stage times explicit.
warp_to $((CROSS_AT - 180))
log "checking the fork is standing in a closing session"
run --sig 'prepare()'

log "opening the cross and committing five intents"
run --sig 'open()'

# freezeAt is crossAt minus 300, so the freeze is already allowed here. It is the
# cross that has to wait for the bell.
warp_to $((CROSS_AT - 120))
log "publishing the indicative price, then pulling the escrow"
run --sig 'freeze()'

warp_to "$CROSS_AT"
log "crossing at the bell"
run --sig 'cross()'

# CHALLENGE_WINDOW is 120 seconds and executeCross wants it strictly past.
warp_to $((CROSS_AT + 121))
log "executing, and reading the print back"
run --sig 'execute()'

printf '\nanvil is still up on %s, pid %s, log %s\n' "$FORK_RPC" "$ANVIL_PID" "$LOG"
printf 'forked mainnet 4663 at block %s\n' "$AUCTION_BLOCK"
