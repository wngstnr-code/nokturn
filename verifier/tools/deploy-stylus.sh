#!/usr/bin/env bash
# Deploys and activates the Stylus verifier through cast, not through cargo stylus.
#
# cargo stylus deploy can sign from a keystore but never prompts for the password. It
# reads it from a file, and a deploy that wants a keystore password on disk is not the
# deploy this project uses. CLAUDE.md rule 5 says cast wallet or a hardware wallet, so
# the initcode is generated here and sent by cast, which prompts.
#
# Two transactions, two prompts. The first creates the contract. The second calls
# activateProgram on the ArbWasm precompile and pays the data fee, because this chain
# has no cache manager and an unactivated program cannot be called at all.
#
# --no-verify is not passed to get-initcode because that flag does not exist there.
# What it produces is the same initcode a non reproducible deploy would send. A
# mainnet deploy should go through the reproducible docker path instead, so that
# somebody recompiling from source gets the same bytes.
set -euo pipefail

cd "$(dirname "$0")/.."

rpc="${1:-${NOKTURN_RPC_TESTNET:-}}"
account="${2:-nokturn-testnet}"
if [ -z "$rpc" ]; then
  echo "usage: tools/deploy-stylus.sh <rpc url> [keystore account]" >&2
  exit 1
fi

ARBWASM=0x0000000000000000000000000000000000000071

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "== building initcode"
(cd stylus && cargo stylus get-initcode --output "$work/initcode.txt" >/dev/null 2>&1)
code="0x$(tr -d '[:space:]' <"$work/initcode.txt" | sed 's/^0x//')"
echo "   ${#code} hex chars"

echo "== reading the activation data fee"
# The escape sequences cargo stylus colours this line with contain digits of their
# own, so they are stripped before anything looks for a number.
fee_eth="$(cd stylus && cargo stylus check --endpoint "$rpc" 2>&1 \
  | sed 's/\x1b\[[0-9;]*m//g' \
  | sed -n 's/.*wasm data fee: \([0-9.]*\) ETH.*/\1/p' | head -1)"
if [ -z "$fee_eth" ]; then
  echo "could not read the data fee from cargo stylus check" >&2
  exit 1
fi
fee_wei="$(cast to-wei "$fee_eth" ether)"
echo "   $fee_eth ETH ($fee_wei wei)"

# --create swallows everything after it as the signature and its arguments, so every
# flag goes in front of it.
echo "== deploying, this prompts for the keystore password"
receipt="$(cast send --account "$account" --rpc-url "$rpc" --json --create "$code")"
addr="$(printf '%s' "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["contractAddress"])')"
echo "   deployed at $addr"

echo "== activating, this prompts again"
cast send --account "$account" --rpc-url "$rpc" --value "$fee_wei" \
  "$ARBWASM" "activateProgram(address)" "$addr" >/dev/null
echo "   activated"

echo
echo "stylus verifier: $addr"
