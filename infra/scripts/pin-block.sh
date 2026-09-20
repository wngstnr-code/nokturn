#!/usr/bin/env bash
# Picks the fork block, proves the endpoint can still serve state there, and
# writes it down. The pinned block is synchronisation point 6 in
# docs/pembagian-tugas.md, so it is committed and all three laptops read it here.
#
# Run this again only when the team agrees to move the block, because moving it
# changes every number on every receipt.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd cast node
load_env

MARGIN="${NOKTURN_FORK_MARGIN:-100000}"
NVDA_POOL=0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3

log "reading head from $NOKTURN_RPC_MAINNET"
HEAD="$(cast block-number --rpc-url "$NOKTURN_RPC_MAINNET")"
BLOCK=$((HEAD - MARGIN))
log "head $HEAD, margin $MARGIN, candidate $BLOCK"

# The boundary test. This endpoint is not documented as an archive node and its
# behaviour moved once between 17 and 20 September 2026, so the depth is measured
# at pin time rather than assumed. If this call fails, lower NOKTURN_FORK_MARGIN.
log "boundary test, slot0 of the NVDA pool at $BLOCK"
if ! SLOT0="$(cast call "$NVDA_POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" \
      --block "$BLOCK" --rpc-url "$NOKTURN_RPC_MAINNET" 2>&1)"; then
  die "endpoint cannot serve state at $BLOCK. lower NOKTURN_FORK_MARGIN and try again. $SLOT0"
fi

TS="$(cast block "$BLOCK" --field timestamp --rpc-url "$NOKTURN_RPC_MAINNET")"
HUMAN="$(node -e 'process.stdout.write(new Date(Number(process.argv[1])*1000).toISOString())' "$TS")"

node -e '
  const fs = require("fs");
  const [file, block, ts, human, head, rpc] = process.argv.slice(1);
  fs.writeFileSync(file, JSON.stringify({
    chainId: 4663,
    block: Number(block),
    timestamp: Number(ts),
    timestampUtc: human,
    measuredAgainstHead: Number(head),
    endpoint: rpc,
    note: "Synchronisation point 6. Moving this block changes every receipt number."
  }, null, 2) + "\n");
' "$PIN_FILE" "$BLOCK" "$TS" "$HUMAN" "$HEAD" "$NOKTURN_RPC_MAINNET"

log "pinned $BLOCK, chain time $HUMAN"
echo "$SLOT0" | head -2
log "wrote $PIN_FILE"
