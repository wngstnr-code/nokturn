#!/usr/bin/env bash
# The backend against mainnet 4663 rather than a fork. api, indexer and
# check-batch only read. bond, solver and keeper sign with keys from .env and
# spend real gas, and bond locks real USDG.
#
#   make rpc-proxy          terminal 1, the official RPC by address
#   make mainnet-indexer    terminal 2
#   make mainnet-api        terminal 3, on 3300 so a fork api on 3000 can stay up
#
#   mainnet.sh bond         once, after the solver's key holds 500 USDG and gas
#   mainnet.sh solver       against the hosted api, see NOKTURN_MAINNET_API_URL
#   mainnet.sh bond b       once, for the keeper's key, 1000 USDG and gas
#   mainnet.sh keeper
#
# Why each process talks to which endpoint, all measured 1 October 2026.
# The indexer reads through the proxy, because the official RPC served 460,000
# blocks in one getLogs and Alchemy's free tier refuses more than 10. The api
# reads through NOKTURN_RPC_MAINNET first, because the official RPC keeps about
# ten minutes of state and a receipt reads its baseline at an older block, and
# falls back to the proxy. Its auction log reads go 10 blocks at a time.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node curl
load_env

PROXY="http://127.0.0.1:${NOKTURN_RPC_PROXY_PORT:-8547}"
DB_URL="${NOKTURN_MAINNET_DATABASE_URL:-postgres://nokturn:nokturn@127.0.0.1:${NOKTURN_DB_PORT:-5440}/nokturn_mainnet}"
# Found by binary search on eth_getCode against an archive endpoint, the first
# block where the mainnet Settlement has code. The official RPC cannot repeat
# that search, it has no history.
FROM_BLOCK="${NOKTURN_MAINNET_FROM_BLOCK:-75694415}"

chain_id="$(curl -s -m 10 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$PROXY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(parseInt(JSON.parse(s).result,16))}catch{console.log("")}})')"
[ "$chain_id" = "4663" ] || die "nothing answers as chain 4663 at $PROXY. run: make rpc-proxy"
[ -f "$CHAIN_RECORD" ] || die "no $CHAIN_RECORD, the mainnet deployment record"

# The mainnet rows get a database of their own, so a fork run never mixes in.
ensure_database() {
  (cd "$REPO_ROOT/indexer" && node --input-type=module -e '
  import pg from "pg";
  const url = new URL(process.argv[1]);
  const name = url.pathname.slice(1);
  url.pathname = "/postgres";
  const admin = new pg.Client({connectionString: url.toString()});
  await admin.connect();
  const {rowCount} = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
' "$DB_URL") 2>/dev/null || die "cannot reach postgres at $(redact_url "$DB_URL"). run: make db-up"
  export NOKTURN_DATABASE_URL="$DB_URL"
}

case "${1:-}" in
  api)
    shift
    ensure_database
    [ -n "${NOKTURN_RPC_MAINNET:-}" ] || die "NOKTURN_RPC_MAINNET is not set in .env"
    export NOKTURN_API_RPC="$NOKTURN_RPC_MAINNET,$PROXY"
    export NOKTURN_API_PUBLIC_RPC="${NOKTURN_API_PUBLIC_RPC:-https://rpc.mainnet.chain.robinhood.com}"
    export NOKTURN_API_PORT="${NOKTURN_MAINNET_API_PORT:-3300}"
    export NOKTURN_API_LOG_BLOCK_RANGE="${NOKTURN_API_LOG_BLOCK_RANGE:-10}"
    log "starting the api on mainnet 4663, port $NOKTURN_API_PORT"
    cd "$REPO_ROOT/api" && exec node src/index.ts "$@"
    ;;
  indexer)
    shift
    ensure_database
    export NOKTURN_INDEXER_RPC="$PROXY"
    export NOKTURN_INDEXER_MAX_RANGE="${NOKTURN_INDEXER_MAX_RANGE:-50000}"
    export NOKTURN_INDEXER_FROM_BLOCK="$FROM_BLOCK"
    log "starting the indexer on mainnet 4663 from block $FROM_BLOCK"
    cd "$REPO_ROOT" && exec node indexer/src/index.ts --confirmations "${NOKTURN_MAINNET_CONFIRMATIONS:-20}" "$@"
    ;;
  check-batch)
    # packages/shared/batch.ts against the mainnet Settlement, moving nothing.
    export NOKTURN_CHECK_RPC="$PROXY"
    cd "$REPO_ROOT" && exec node infra/scripts/check-batch.mjs
    ;;

  # Everything below signs with a key from .env and spends real gas, and bond
  # locks real USDG. Nothing here ever prints a key. The solver signs with
  # NOKTURN_SOLVER_PRIVATE_KEY and the keeper with NOKTURN_SOLVER_B_PRIVATE_KEY,
  # because both take the pending nonce from the chain and the keeper does not
  # retry a collision. The keeper's key needs its own bond, since submitCross
  # wants an active solver, plus AuctionHouse's 500 USDG cross bond.
  #   mainnet.sh bond      the solver's key, NOKTURN_SOLVER_PRIVATE_KEY
  #   mainnet.sh bond b    the keeper's key, NOKTURN_SOLVER_B_PRIVATE_KEY
  bond)
    variable=NOKTURN_SOLVER_PRIVATE_KEY
    [ "${2:-a}" = "b" ] && variable=NOKTURN_SOLVER_B_PRIVATE_KEY
    key="${!variable:-}"
    [ -n "$key" ] || die "$variable is not set in .env"
    solver="$(cast wallet address --private-key "$key")"
    registry="$(json_get "$CHAIN_RECORD" solvers)"
    usdg="$(json_get "$CHAIN_RECORD" usdg)"
    first() { cut -d' ' -f1; }
    if [ "$(cast call "$registry" "isActive(address)(bool)" "$solver" --rpc-url "$PROXY")" = "true" ]; then
      log "$solver is already bonded and active"
      exit 0
    fi
    min="$(cast call "$registry" "minBond()(uint256)" --rpc-url "$PROXY" | first)"
    held="$(cast call "$usdg" "balanceOf(address)(uint256)" "$solver" --rpc-url "$PROXY" | first)"
    node -e 'process.exit(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 0 : 1)' "$held" "$min" \
      || die "$solver holds $held USDG units and the bond is $min. send USDG to it first"
    log "approving $min USDG units to SolverRegistry $registry"
    cast send "$usdg" "approve(address,uint256)" "$registry" "$min" --private-key "$key" --rpc-url "$PROXY" >/dev/null
    log "bonding from $solver"
    cast send "$registry" "bond(uint256)" "$min" --private-key "$key" --rpc-url "$PROXY" >/dev/null
    log "active: $(cast call "$registry" "isActive(address)(bool)" "$solver" --rpc-url "$PROXY")"
    ;;
  solver)
    shift
    export NOKTURN_SOLVER_RPC="$PROXY"
    export NOKTURN_API_URL="${NOKTURN_MAINNET_API_URL:-https://nokturn-production.up.railway.app}"
    log "starting the solver on mainnet 4663 against $NOKTURN_API_URL"
    cd "$REPO_ROOT" && exec node solver/src/index.ts --run "$@"
    ;;
  keeper)
    shift
    export NOKTURN_SOLVER_RPC="$PROXY"
    log "starting the auction keeper on mainnet 4663, signing with NOKTURN_SOLVER_B_PRIVATE_KEY"
    cd "$REPO_ROOT" && exec node solver/src/keeper.ts --profile b "$@"
    ;;
  *)
    die "usage: mainnet.sh api | indexer | check-batch | bond | solver | keeper"
    ;;
esac
