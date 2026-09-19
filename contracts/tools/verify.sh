#!/usr/bin/env bash
# Verifies every contract a deploy put on chain, against Sourcify.
#
# Blockscout is the explorer this chain uses, and it is also the one route that
# does not work from here. Its domain is intercepted by Indonesian ISP DNS, and as
# of 19 September 2026 the origin behind the --resolve workaround answers a
# Cloudflare challenge rather than the API, so forge cannot reach it. Sourcify
# lists chain 4663 as supported, reaches from this network with no workaround at
# all, and Blockscout reads Sourcify. See pertanyaan-terbuka.md.
#
# foundry.toml sets bytecode_hash to none and turns CBOR metadata off, so the
# deployed bytecode carries no metadata trailer. A verifier recompiling from the
# standard json below produces the same bytes, which is the match that matters.
# What it does not produce is a metadata hash to compare, so Sourcify records these
# as a match rather than an exact match. That is a property of the compiler
# settings rather than of the verification.
set -euo pipefail
cd "$(dirname "$0")/.."

chain="${1:-}"
if [ -z "$chain" ]; then
  echo "usage: tools/verify.sh <chain id>" >&2
  exit 1
fi

record="deployments/${chain}.json"
if [ ! -f "$record" ]; then
  echo "verify: no deploy recorded at $record" >&2
  exit 1
fi

get() { python3 -c "import json,sys; print(json.load(open('$record'))['$1'])"; }
getlist() {
  python3 -c "
import json
v = json.load(open('$record'))['$1']
print('[' + ','.join(v) + ']')
"
}

timelock=$(get timelock)
treasury=$(get treasury)
usdg=$(get usdg)
permit2=$(get permit2)
proposers=$(getlist proposers)
executors=$(getlist executors)

verify() {
  local address="$1" target="$2" args="${3:-}"
  echo "== $target $address"
  if [ -n "$args" ]; then
    forge verify-contract "$address" "$target" \
      --chain "$chain" --verifier sourcify --constructor-args "$args" --watch
  else
    forge verify-contract "$address" "$target" \
      --chain "$chain" --verifier sourcify --watch
  fi
}

verify "$timelock" \
  "lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController" \
  "$(cast abi-encode 'c(uint256,address[],address[],address)' 0 "$proposers" "$executors" 0x0000000000000000000000000000000000000000)"

verify "$(get sessions)" "src/SessionManager.sol:SessionManager" \
  "$(cast abi-encode 'c(address)' "$timelock")"

verify "$(get verifier)" "src/ClearingVerifier.sol:ClearingVerifier"

verify "$(get oracle)" "src/PriceOracle.sol:PriceOracle" \
  "$(cast abi-encode 'c(address,address)' "$(get sessions)" "$timelock")"

verify "$(get solvers)" "src/SolverRegistry.sol:SolverRegistry" \
  "$(cast abi-encode 'c(address,address,address)' "$usdg" "$treasury" "$timelock")"

verify "$(get settlement)" "src/Settlement.sol:Settlement" \
  "$(cast abi-encode 'c(address,address,address,address,address,address,address)' \
    "$(get sessions)" "$(get oracle)" "$(get verifier)" "$(get solvers)" "$permit2" "$treasury" "$timelock")"

verify "$(get auctionHouse)" "src/AuctionHouse.sol:AuctionHouse" \
  "$(cast abi-encode 'c(address,address,address,address,address,address,address)' \
    "$(get sessions)" "$(get oracle)" "$(get solvers)" "$permit2" "$usdg" "$treasury" "$timelock")"

verify "$(get mandates)" "src/AgentMandate.sol:AgentMandate" \
  "$(cast abi-encode 'c(address,address,address,address,address)' \
    "$(get sessions)" "$(get oracle)" "$permit2" "$(get settlement)" "$(get auctionHouse)")"

verify "$(get adapter)" "src/adapters/UniswapV3Adapter.sol:UniswapV3Adapter" \
  "$(cast abi-encode 'c(address)' "$timelock")"

echo
echo "all contracts submitted to sourcify for chain $chain"
