#!/usr/bin/env bash
# The solver and the auction keeper against testnet 46630.
#
#   testnet.sh bond         once, for the solver's key
#   testnet.sh bond b       once, for the keeper's key
#   testnet.sh solver       against NOKTURN_TESTNET_API_URL
#   testnet.sh keeper
#
# Nothing here spends real money. The quote token on 46630 is the tQUOTE
# fixture, whose mint is open to anyone, so bond mints what the key is short of
# before it approves and bonds. Gas is testnet ETH, which the key must already
# hold.
#
# The keys have names of their own, NOKTURN_TESTNET_SOLVER_PRIVATE_KEY and
# NOKTURN_TESTNET_KEEPER_PRIVATE_KEY, so one .env can carry the mainnet keys
# beside them. Each is handed to the solver under the name it reads. A testnet
# key equal to a mainnet key is refused, the two key rule of runbook-deploy.md.
#
# The official endpoint is the default. From an Indonesian ISP its name resolves
# to a block page (CLAUDE.md section 9), so on a laptop set NOKTURN_TESTNET_RPC
# to something that reaches it. On Railway the default works.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node cast
load_env

RPC="${NOKTURN_TESTNET_RPC:-https://rpc.testnet.chain.robinhood.com}"
RECORD="$CONTRACTS_DIR/deployments/46630.json"
[ -f "$RECORD" ] || die "no $RECORD, the testnet deployment record"

chain_id="$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)"
[ "$chain_id" = "46630" ] || die "nothing answers as chain 46630 at $(redact_url "$RPC"). set NOKTURN_TESTNET_RPC"

# key_for <a|b> prints the testnet key for that profile, refusing a missing key
# and one that is also a mainnet key.
key_for() {
  local variable=NOKTURN_TESTNET_SOLVER_PRIVATE_KEY
  [ "$1" = "b" ] && variable=NOKTURN_TESTNET_KEEPER_PRIVATE_KEY
  local key="${!variable:-}"
  [ -n "$key" ] || die "$variable is not set"
  for mainnet in NOKTURN_SOLVER_PRIVATE_KEY NOKTURN_SOLVER_B_PRIVATE_KEY; do
    [ "$key" != "${!mainnet:-}" ] || die "$variable is the same key as $mainnet. testnet and mainnet keys stay apart"
  done
  printf '%s' "$key"
}

first() { cut -d' ' -f1; }
at_least() { node -e 'process.exit(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 0 : 1)' "$1" "$2"; }

case "${1:-}" in
  # The keeper's key also needs AuctionHouse's cross bond, and the keeper
  # approves four of them at once, so b mints for those as well.
  bond)
    profile="${2:-a}"
    key="$(key_for "$profile")"
    account="$(cast wallet address --private-key "$key")"
    registry="$(json_get "$RECORD" solvers)"
    quote="$(json_get "$RECORD" usdg)"
    house="$(json_get "$RECORD" auctionHouse)"
    [ "$(cast call "$quote" "symbol()(string)" --rpc-url "$RPC")" = '"tQUOTE"' ] || die "$quote is not the tQUOTE fixture. refusing to mint or bond against it"

    min="$(cast call "$registry" "minBond()(uint256)" --rpc-url "$RPC" | first)"
    need="$min"
    if [ "$profile" = "b" ]; then
      cross="$(cast call "$house" "bond()(uint256)" --rpc-url "$RPC" | first)"
      need="$(node -e 'console.log((BigInt(process.argv[1]) + 4n * BigInt(process.argv[2])).toString())' "$min" "$cross")"
    fi

    gas="$(cast balance "$account" --rpc-url "$RPC")"
    [ "$gas" != "0" ] || die "$account holds no testnet ETH. send it some gas first"

    active="$(cast call "$registry" "isActive(address)(bool)" "$account" --rpc-url "$RPC")"
    [ "$active" = "true" ] && need="$(node -e 'console.log((BigInt(process.argv[1]) - BigInt(process.argv[2])).toString())' "$need" "$min")"

    held="$(cast call "$quote" "balanceOf(address)(uint256)" "$account" --rpc-url "$RPC" | first)"
    if ! at_least "$held" "$need"; then
      short="$(node -e 'console.log((BigInt(process.argv[1]) - BigInt(process.argv[2])).toString())' "$need" "$held")"
      log "minting $short tQUOTE units to $account"
      cast send "$quote" "mint(address,uint256)" "$account" "$short" --private-key "$key" --rpc-url "$RPC" >/dev/null
    fi

    if [ "$active" = "true" ]; then
      log "$account is already bonded and active on SolverRegistry $registry"
      exit 0
    fi
    log "approving $min tQUOTE units to SolverRegistry $registry"
    cast send "$quote" "approve(address,uint256)" "$registry" "$min" --private-key "$key" --rpc-url "$RPC" >/dev/null
    log "bonding from $account"
    cast send "$registry" "bond(uint256)" "$min" --private-key "$key" --rpc-url "$RPC" >/dev/null
    log "active: $(cast call "$registry" "isActive(address)(bool)" "$account" --rpc-url "$RPC")"
    ;;
  solver)
    shift
    NOKTURN_SOLVER_PRIVATE_KEY="$(key_for a)"
    [ -n "${NOKTURN_TESTNET_API_URL:-}" ] || die "NOKTURN_TESTNET_API_URL is not set, the testnet coordinator the solver reads batches from"
    export NOKTURN_SOLVER_PRIVATE_KEY NOKTURN_SOLVER_RPC="$RPC" NOKTURN_API_URL="$NOKTURN_TESTNET_API_URL"
    log "starting the solver on testnet 46630 against $NOKTURN_API_URL"
    cd "$REPO_ROOT" && exec node solver/src/index.ts --run "$@"
    ;;
  keeper)
    shift
    NOKTURN_SOLVER_B_PRIVATE_KEY="$(key_for b)"
    export NOKTURN_SOLVER_B_PRIVATE_KEY NOKTURN_SOLVER_RPC="$RPC"
    log "starting the auction keeper on testnet 46630"
    cd "$REPO_ROOT" && exec node solver/src/keeper.ts --profile b "$@"
    ;;
  *)
    die "usage: testnet.sh bond [b] | solver | keeper"
    ;;
esac
