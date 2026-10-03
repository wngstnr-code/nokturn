#!/usr/bin/env bash
# One real batch on chain 46630, routed or netted, from contracts straight to a
# receipt. See script/testnet/TestnetSmoke.s.sol for why it is split this way.
#
#   NOKTURN_SMOKE_MNEMONIC="..." tools/smoke-testnet.sh prepare
#   NOKTURN_SMOKE_MNEMONIC="..." tools/smoke-testnet.sh routed
#   NOKTURN_SMOKE_MNEMONIC="..." tools/smoke-testnet.sh netted
#
# The mnemonic is a throwaway one for test tokens and dust. It is passed at run
# time and never belongs in .env, which holds no private keys at all.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NOKTURN_RPC_TESTNET:?load the root .env first}"
: "${NOKTURN_SMOKE_MNEMONIC:?pass the throwaway mnemonic for this run}"

RPC=$NOKTURN_RPC_TESTNET
SCRIPT=script/testnet/TestnetSmoke.s.sol:TestnetSmoke
SETTLEMENT=$(jq -r .settlement deployments/46630.json)
SESSIONS=$(jq -r .sessions deployments/46630.json)

# A forge run to build and sign takes well under this, and the batch it signs for
# must still be open when the build finishes.
LEAD=75

# submitSolution used 359,702 gas routed and 384,839 netted on a fork of 46630,
# 3 October 2026. It is sent with a fixed limit because estimating it before the
# window opens reverts.
SUBMIT_GAS=1000000

BATCH_SETTLED=0xcbbbf7ce1cd15c55453ffbda91b7b0d767839610326dc2cc981aea12bc8e42c0
BATCH_PASSTHROUGH=0x36bf95df3edf4b3fd4d78a8bdff6f957318d860c40205de0ea79b7a78631440d

chain_time() { cast block latest --field timestamp --rpc-url "$RPC"; }
first() { awk '{print $1}'; }

wait_past() {
  while [ "$(chain_time)" -le "$1" ]; do sleep 0.5; done
}

case "${1:-}" in
  prepare)
    forge script "$SCRIPT" --sig 'addresses()' --rpc-url "$RPC" | grep -E 'solver|alice|bob'
    forge script "$SCRIPT" --sig 'prepare()' --rpc-url "$RPC" --broadcast
    exit 0
    ;;
  routed) ROUTED=true ;;
  netted) ROUTED=false ;;
  *) echo "usage: $0 prepare|routed|netted" >&2; exit 2 ;;
esac

target=$(( $(chain_time) + LEAD ))
session=$(cast call "$SESSIONS" 'sessionAt(uint64)(uint8)' "$target" --rpc-url "$RPC" | first)
duration=$(cast call "$SESSIONS" 'batchDuration(uint8)(uint32)' "$session" --rpc-url "$RPC" | first)
batch=$(( (target / duration + 1) * duration ))
while [ "$(cast call "$SESSIONS" 'inGuardBand(uint64)(bool)' "$batch" --rpc-url "$RPC")" = "true" ]; do
  batch=$(( batch + duration ))
done
echo "session $session, batch $batch, closes in $(( batch - $(chain_time) ))s"

built=$(forge script "$SCRIPT" --sig 'build(uint64,bool)' "$batch" "$ROUTED" --rpc-url "$RPC")
submit=$(echo "$built" | awk '/^  submit$/{getline; print $1}')
finalize=$(echo "$built" | awk '/^  finalize$/{getline; print $1}')
echo "$built" | grep -E 'claimedSavings'
[ -n "$submit" ] && [ -n "$finalize" ] || { echo "$built" >&2; exit 1; }

if [ "$(chain_time)" -ge "$batch" ]; then
  echo "the build ran past the batch, raise LEAD" >&2
  exit 1
fi

key=$(cast wallet private-key "$NOKTURN_SMOKE_MNEMONIC" 0)

wait_past "$batch"
tx=$(cast send "$SETTLEMENT" --data "$submit" --gas-limit "$SUBMIT_GAS" --private-key "$key" \
  --rpc-url "$RPC" --json | jq -r '.transactionHash + " " + .status')
echo "submit   $tx"

wait_past $(( batch + 10 ))
receipt=$(cast send "$SETTLEMENT" --data "$finalize" --private-key "$key" --rpc-url "$RPC" --json)
echo "finalize $(echo "$receipt" | jq -r '.transactionHash + " " + .status')"

topics=$(echo "$receipt" | jq -r '.logs[].topics[0]')
if echo "$topics" | grep -q "$BATCH_SETTLED"; then
  echo "BatchSettled for batch $batch"
elif echo "$topics" | grep -q "$BATCH_PASSTHROUGH"; then
  echo "BatchPassthrough for batch $batch" >&2
  exit 1
else
  echo "finalize emitted neither event" >&2
  exit 1
fi
