#!/usr/bin/env bash
#
# Stands the whole protocol up on a fork of mainnet 4663 and drives two batches
# through it, one that beats the pool and one that does not.
#
# The demo runs in the weekend session on purpose. That is the session where the
# Chainlink feeds are frozen for two days and the price has to come from the pool
# instead, and it carries 33.2 percent of this chain's trades. Anything that works
# only while the feeds are live is not the thing worth showing.
#
# The fork block is printed and written into deployments/demo.json, because
# demo.md section 1 stakes the demo on somebody recomputing the baseline, and
# without the block there is nothing to recompute it against.
#
# Leaves anvil running on 8545 so the frontend and the indexer have a chain to
# talk to. Stop it with the pid that is printed at the end.

set -euo pipefail

RPC="${NOKTURN_RPC_MAINNET:-https://robinhood.drpc.org}"
LOCAL="http://127.0.0.1:8545"
PORT=8545
CHAIN_ID=4663

# Anvil account zero, from its published test mnemonic. It pays for the deploy and
# holds nothing else.
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# The AAPL pool holds USDG and is not the pool the baseline is read from, so
# borrowing from it cannot move the number the demo is about. Override with
# NOKTURN_DEMO_USDG_SOURCE if it has been drained.
USDG_SOURCE="${NOKTURN_DEMO_USDG_SOURCE:-0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D}"

# The batch time is not written down. It is found from the chain, and the reason is
# that a fork cannot advance an external feed. Warping to a fixed Saturday five days
# out leaves every Chainlink round five days old, and the quote asset is checked
# against wall clock in every session, so the whole batch fails on a feed that is
# perfectly healthy in reality. The harness therefore walks forward to the NEAREST
# session it can settle in, which is tonight when run on a weekday and right now
# when run at the weekend.

cd "$(dirname "$0")/../contracts"

# The fork keeps mainnet's chain id, because SetFeeds refuses any other and it is
# right to. Every production script then runs here exactly as it would on chain,
# with no demo branch anywhere, which is most of the value of rehearsing at all.
#
# The cost is that the deploy writes to the file a real mainnet deploy would own.
# So the demo refuses to start when that file exists, and removes its own on the
# way out. A rehearsal must never be mistaken for the record of what is on chain.
RECORD=deployments/4663.json
if [ -e "$RECORD" ]; then
  echo "$RECORD exists. That is the record of a real mainnet deploy, and this"
  echo "demo would overwrite it. Move it aside first, then run this again."
  exit 1
fi
# NOKTURN_DEMO_KEEP leaves the record in place so a failed stage can be rerun by
# hand against the anvil that is still up. It is a debugging aid, not a mode.
if [ -z "${NOKTURN_DEMO_KEEP:-}" ]; then
  trap 'rm -f "$RECORD"' EXIT
fi

say() { printf '\n== %s\n' "$1"; }

warp_to() {
  # Mine an empty block at the target time before the script runs. Forge simulates
  # against the latest block, so a timestamp that only arrives with the broadcast
  # would make every window check fail in simulation and never reach the chain.
  cast rpc --rpc-url "$LOCAL" evm_setNextBlockTimestamp "$1" >/dev/null
  cast rpc --rpc-url "$LOCAL" evm_mine >/dev/null
}

run() {
  forge script "$1" --rpc-url "$LOCAL" --broadcast --unlocked --sender "$DEPLOYER" "${@:2}" >/dev/null
}

# cast prints "1790019000 [1.79e9]" and shell arithmetic chokes on the second half.
callnum() {
  cast call --rpc-url "$LOCAL" "$@" | awk '{print $1}'
}

say "selecting the fork block"
HEAD=$(cast bn --rpc-url "$RPC")
# Same margin as ForkFixture. Blocks here are about 100ms and the head moves while
# the fork is still being read, so the fork steps back to something settled.
FORK_BLOCK=$((HEAD - 300))
echo "head $HEAD, forking at $FORK_BLOCK"

say "starting anvil"
ANVIL_LOG="${TMPDIR:-/tmp}/nokturn-anvil.log"
nohup anvil --fork-url "$RPC" --fork-block-number "$FORK_BLOCK" --chain-id "$CHAIN_ID" \
  --port "$PORT" --auto-impersonate >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
disown "$ANVIL_PID" 2>/dev/null || true
for _ in $(seq 1 60); do
  if cast bn --rpc-url "$LOCAL" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
cast bn --rpc-url "$LOCAL" >/dev/null || { echo "anvil never came up"; exit 1; }

# Every one of these is the deployer on a throwaway chain. On mainnet they are
# three different signers and one of them is a hardware wallet.
export NOKTURN_TREASURY="$DEPLOYER"
export NOKTURN_GUARDIAN="$DEPLOYER"
export NOKTURN_TIMELOCK_PROPOSERS="$DEPLOYER"
export NOKTURN_TIMELOCK_EXECUTORS="$DEPLOYER"

say "deploy"
run script/Deploy.s.sol
say "bootstrap, calendar and allowlist"
run script/Bootstrap.s.sol
say "feeds and twap sources"
# SetFeeds is two steps by design. The first run schedules the batch and the second
# executes it, which on mainnet is forty eight hours apart and here is back to back
# because the delay is still zero. Running it once leaves the oracle blind.
run script/SetFeeds.s.sol
run script/SetFeeds.s.sol
say "lock, timelock delay to forty eight hours"
run script/Lock.s.sol

say "choosing the session"
SESSIONS=$(python3 -c "import json;print(json.load(open('deployments/4663.json'))['sessions'])")
NOW=$(cast block latest --rpc-url "$LOCAL" --field timestamp | awk '{print $1}')

# CLOSED_WEEKEND is 6 and CLOSED_OVERNIGHT is 0. Both are closed sessions with a
# frozen or slow feed picture, which is what this demo is about. Walk the real
# boundaries rather than guessing, because Friday evening and Saturday evening are
# both closed and a bisection would miss the transition between them.
CURSOR=$((NOW + 120))
BATCH_SETTLED=""
for _ in $(seq 1 12); do
  S=$(callnum "$SESSIONS" "sessionAt(uint64)(uint8)" "$CURSOR")
  if [ "$S" = "6" ] || [ "$S" = "0" ]; then
    DUR=$(callnum "$SESSIONS" "batchDuration(uint8)(uint32)" "$S")
    # Step well inside the session so neither edge lands in the guard band.
    MID=$((CURSOR + 1800))
    BATCH_SETTLED=$(( (MID / DUR) * DUR ))
    SESSION_NAME=$([ "$S" = "6" ] && echo CLOSED_WEEKEND || echo CLOSED_OVERNIGHT)
    break
  fi
  CURSOR=$(callnum "$SESSIONS" "nextTransition(uint64)(uint64)" "$CURSOR")
  CURSOR=$((CURSOR + 60))
done
[ -n "$BATCH_SETTLED" ] || { echo "no closed session found ahead"; exit 1; }

# Ten batches later, still aligned. A boundary that is not a multiple of the
# session's own duration is refused, and the duration differs per session.
BATCH_PASSTHROUGH=$((BATCH_SETTLED + 10 * DUR))
FUND_AT=$((BATCH_SETTLED - 600))
AHEAD=$(( (BATCH_SETTLED - NOW) / 3600 ))
echo "$SESSION_NAME at $BATCH_SETTLED, $AHEAD hours ahead of the fork"

warp_to "$FUND_AT"
cast rpc --rpc-url "$LOCAL" anvil_impersonateAccount "$USDG_SOURCE" >/dev/null
# A pool holds tokens, not gas. Impersonating it is not enough to send from it.
cast rpc --rpc-url "$LOCAL" anvil_setBalance "$USDG_SOURCE" 0xde0b6b3a7640000 >/dev/null

say "funding, bob buys his nvda on the real pool"
run script/demo/ForkDemo.s.sol --sig 'fund(address)' "$USDG_SOURCE"

say "batch one, netted against the pool"
warp_to $((BATCH_SETTLED + 2))
run script/demo/ForkDemo.s.sol --sig 'submit(uint64,bool)' "$BATCH_SETTLED" false
warp_to $((BATCH_SETTLED + 12))
run script/demo/ForkDemo.s.sol --sig 'finalize(uint64,bool)' "$BATCH_SETTLED" false

# The pass through screen is not built yet, and the reason is worth writing down.
# A batch with both sides present always beats the venue, because the counterparties
# skip the round trip the pool would have charged twice. So a solution cannot be made
# to lose by pricing it badly. The honest construction is two intents on the SAME
# side, routed to the venue in full, where the executed amount is the venue quote and
# the surplus really is zero. That needs the venue call path, which this harness does
# not exercise yet.

say "writing deployments/demo.json"
run script/demo/ForkDemo.s.sol --sig 'report(uint64,uint64,uint256)' \
  "$BATCH_SETTLED" 0 "$FORK_BLOCK"

cat deployments/demo.json
printf '\nanvil is still up on %s, pid %s, log %s\n' "$LOCAL" "$ANVIL_PID" "$ANVIL_LOG"
printf 'forked mainnet 4663 at block %s\n' "$FORK_BLOCK"
