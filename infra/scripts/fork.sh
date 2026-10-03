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

# Anvil's default accounts are unusable on this chain. Their private keys are
# published, so somebody has set an EIP-7702 delegation on all ten of them on
# mainnet 4663, and an account with code sends Permit2 down the EIP-1271 path
# where a valid ECDSA signature is rejected with an empty revert. Measured
# 20 September 2026 against the real chain. infra/accounts.json carries the
# addresses this mnemonic derives, and make fund re-checks they are still bare.
MNEMONIC="${NOKTURN_FORK_MNEMONIC:-spin skill strategy deal rebel image eager original crowd baby inhale calm}"

ARGS=(
  # 0.0.0.0 only inside the compose network, where docker-compose.yml still
  # publishes the port on 127.0.0.1 alone.
  --host "${NOKTURN_FORK_HOST:-127.0.0.1}"
  --mnemonic "$MNEMONIC"
  --port "$PORT"
  --chain-id 4663
  --block-time "$BLOCK_TIME"
  # Every demo account moves tokens it was handed by a real holder, and the
  # replay harness sends from addresses whose keys nobody has. Both need this.
  --auto-impersonate
)

# Anvil moves block states it no longer holds in memory to a folder per run
# under ~/.foundry/anvil/tmp, and a run that is killed or put to sleep never
# removes its own. Eight runs left 17 GB there by 2 October 2026. Nothing reads
# a dead run's folder. An anvil on another port is still alive, though, so the
# sweep is skipped whenever any anvil process is running.
anvil_running() {
  if command -v tasklist >/dev/null 2>&1; then
    tasklist //FI "IMAGENAME eq anvil.exe" 2>/dev/null | grep -qi anvil.exe
  else
    pgrep -x anvil >/dev/null 2>&1
  fi
}
ANVIL_TMP="${HOME}/.foundry/anvil/tmp"
if [ -d "$ANVIL_TMP" ] && ! anvil_running; then
  stale="$(find "$ANVIL_TMP" -mindepth 1 -maxdepth 1 -name 'anvil-state-*' | wc -l)"
  if [ "$stale" -gt 0 ]; then
    log "removing $stale state folders left by earlier anvil runs in $ANVIL_TMP"
    find "$ANVIL_TMP" -mindepth 1 -maxdepth 1 -name 'anvil-state-*' -exec rm -rf {} +
  fi
fi

# Caps the states kept on disk, so a fork left running for hours stops growing.
# 3600 blocks is an hour at one block a second. It has to stay above the 800
# block window the indexer's I8 test recomputes baselines in, and above the age
# of any receipt a cast command is shown for during a demo.
ARGS+=(--max-persisted-states "${NOKTURN_FORK_PERSISTED_STATES:-3600}")

BLOCK="$(pinned_block)"
SHOWN="$(redact_url "$NOKTURN_RPC_MAINNET")"
log "forking $SHOWN at block $BLOCK"
ARGS+=(--fork-url "$NOKTURN_RPC_MAINNET" --fork-block-number "$BLOCK")

log "anvil ${ARGS[*]/"$NOKTURN_RPC_MAINNET"/$SHOWN}"
exec anvil "${ARGS[@]}"
