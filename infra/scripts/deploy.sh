#!/usr/bin/env bash
# Puts Nokturn on the running fork, using Wangsit's scripts unchanged.
#
# Order differs from docs/runbook-deploy.md in exactly one way, and the difference
# is deliberate. On mainnet SetFeeds runs two days after Lock, through the full
# forty eight hour delay. Here it runs before Lock, while the delay is still zero,
# because a fork cannot sit through two days. Lock is a separate target and is not
# run by default, since raising the delay would freeze every parameter the demo
# still needs to move.
#
# Nothing here is a shortcut through a gate that protects funds. The timelock
# delay protects mainnet users, and this chain has none.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd forge cast node
load_env
load_accounts
require_fork

CHAIN="$(cast chain-id --rpc-url "$FORK_RPC")"
[ "$CHAIN" = "4663" ] || die "fork reports chain id $CHAIN, expected 4663"

# Deploy.s.sol writes deployments/<chainid>.json, and on this fork that is the
# same path a real mainnet deploy would write. Refuse rather than overwrite it.
if [ -f "$CHAIN_RECORD" ]; then
  if git -C "$REPO_ROOT" ls-files --error-unmatch "contracts/deployments/4663.json" >/dev/null 2>&1; then
    die "contracts/deployments/4663.json is committed, which means mainnet is deployed. back it up and remove it before running a fork deploy"
  fi
  warn "leftover contracts/deployments/4663.json from an earlier fork run, removing"
  rm -f "$CHAIN_RECORD"
fi

export NOKTURN_TREASURY="$TREASURY"
export NOKTURN_GUARDIAN="$GUARDIAN"
export NOKTURN_TIMELOCK_PROPOSERS="$PROPOSER"
export NOKTURN_TIMELOCK_EXECUTORS="$PROPOSER"

run_script() {
  local name="$1" sender="$2"
  log "$name as $sender"
  ( cd "$CONTRACTS_DIR" && forge script "script/$name.s.sol:$name" \
      --rpc-url "$FORK_RPC" --unlocked --sender "$sender" --broadcast --slow )
}

run_script Deploy   "$DEPLOYER"
run_script Bootstrap "$PROPOSER"

# SetFeeds schedules on the first call and executes on the second. With the delay
# at zero the operation is ready the moment it is scheduled, so two calls is the
# whole story rather than a two day wait.
run_script SetFeeds "$PROPOSER"
run_script SetFeeds "$PROPOSER"

cp "$CHAIN_RECORD" "$FORK_RECORD"
# Taken back out of the contracts tree so it can never be committed as if it were
# a mainnet record. The backend reads infra/fork-deployment.json.
rm -f "$CHAIN_RECORD"

log "wrote $FORK_RECORD"
node -e '
  const d = require(process.argv[1]);
  for (const k of Object.keys(d).sort()) console.log("  " + k.padEnd(14), d[k]);
' "$FORK_RECORD"

SETTLEMENT="$(json_get "$FORK_RECORD" settlement)"
log "checking the oracle answers before calling this done"
for t in NVDA:0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC AAPL:0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9; do
  sym="${t%%:*}"; addr="${t#*:}"
  out="$(cast call "$(json_get "$FORK_RECORD" oracle)" "refPrice(address)(uint256,uint64,bool)" "$addr" --rpc-url "$FORK_RPC" | tr '\n' ' ')"
  echo "  refPrice $sym: $out"
done
log "settlement at $SETTLEMENT"
