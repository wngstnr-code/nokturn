#!/usr/bin/env bash
# Starts anvil against the pinned block.
#
# There is no offline mode. anvil --dump-state does not capture every slot a
# fork fetched lazily, so a reload answers slot0 and then zero for liquidity,
# and quoteFromState reverts. Measured 20 September 2026. The reset that does
# work is evm_snapshot, which is make snapshot and make revert.
#
# Chain id stays 4663 on purpose. SetFeeds.s.sol refuses any other chain, because
# only mainnet carries the Chainlink proxies, and without feeds PriceOracle
# answers unhealthy and every solution reverts with OracleUnhealthy. So a fork
# that cannot run SetFeeds cannot settle a single batch.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd anvil cast node
load_env

PORT="${NOKTURN_FORK_PORT:-8545}"
BLOCK_TIME="${NOKTURN_FORK_BLOCK_TIME:-1}"

# Settlement.SOLUTION_WINDOW is ten seconds, and a solution is only accepted by a
# block whose timestamp lands inside it. Measured 20 September 2026 at a fifteen
# second block time, the offsets that occurred were 11, 12, 27, 42 and 57, so the
# window was never once reached and no solution could be submitted at all. The
# symptom looks exactly like a broken solver, so it is refused here instead.
# docs/rencana-backend.md section 3B, finding R3.
if [ "$BLOCK_TIME" -gt 5 ] 2>/dev/null; then
  die "block time ${BLOCK_TIME}s leaves the 10s solution window unreachable. keep it at 5 or below"
fi

if fork_is_up; then
  die "something already answers at $FORK_RPC. stop it first, or set NOKTURN_FORK_PORT"
fi

ARGS=(
  --host 127.0.0.1
  --port "$PORT"
  --chain-id 4663
  --block-time "$BLOCK_TIME"
  # Every demo account moves tokens it was handed by a real holder, and the
  # replay harness sends from addresses whose keys nobody has. Both need this.
  --auto-impersonate
)

BLOCK="$(pinned_block)"
log "forking $NOKTURN_RPC_MAINNET at block $BLOCK"
ARGS+=(--fork-url "$NOKTURN_RPC_MAINNET" --fork-block-number "$BLOCK")

log "anvil ${ARGS[*]}"
exec anvil "${ARGS[@]}"
