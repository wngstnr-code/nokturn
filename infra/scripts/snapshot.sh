#!/usr/bin/env bash
# Takes an evm_snapshot and writes the id down. This is the reset that actually
# works on a fork, and it is what the demo leans on.
#
# The state dump cannot do this job. anvil --dump-state does not capture every
# slot a fork fetched lazily, measured 20 September 2026: slot0 of a pool comes
# back after a reload while liquidity and the tick bitmap come back as zero, so
# quoteFromState reverts with LiquidityExhausted. The Uniswap TWAP path would
# also need the whole observations array, 6000 entries on NVDA, which is not
# copyable slot by slot either.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd cast
require_fork

ID="$(cast rpc evm_snapshot --rpc-url "$FORK_RPC" | tr -d '"')"
echo "$ID" > "$INFRA_DIR/.snapshot-id"
log "snapshot $ID, revert with: make revert"
