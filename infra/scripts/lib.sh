#!/usr/bin/env bash
# Shared helpers for every script in this directory. Sourced, never executed.
#
# No jq anywhere. Node is already a hard dependency of the backend, and jq is not
# installed on all three laptops, so JSON is read through node.

set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"

# Derived from the port rather than hardcoded, because fork.sh tells you to set
# NOKTURN_FORK_PORT when 8545 is busy and that advice has to actually work.
FORK_RPC="${NOKTURN_FORK_RPC:-http://127.0.0.1:${NOKTURN_FORK_PORT:-8545}}"
PIN_FILE="$INFRA_DIR/pinned-block.json"
ACCOUNTS_FILE="$INFRA_DIR/accounts.json"
FORK_RECORD="$INFRA_DIR/fork-deployment.json"
CHAIN_RECORD="$CONTRACTS_DIR/deployments/4663.json"
# Where the committed mainnet record waits while a fork run borrows its path. It
# sits under infra/ rather than in a temp dir because the deploy container sees
# infra/ and contracts/ from the host but has no .git, so a record parked in the
# container would die with it.
PARKED_RECORD="$INFRA_DIR/.mainnet-record.json"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m/!\\\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxxx\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "missing command: $c"
  done
}

# json_get <file> <dotted.path>
json_get() {
  node -e '
    const fs = require("fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((a, k) => (a == null ? a : a[k]), doc);
    if (value === undefined || value === null) { process.exit(3); }
    process.stdout.write(String(value));
  ' "$1" "$2"
}

load_env() {
  if [ -f "$REPO_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$REPO_ROOT/.env"
    set +a
  fi
  : "${NOKTURN_RPC_MAINNET:=https://robinhood.drpc.org}"
  export NOKTURN_RPC_MAINNET
}

# A paid RPC carries its key in the path, so only the scheme and host are ever
# printed or written to a committed file.
redact_url() {
  printf '%s' "$1" | sed -E 's#^(https?://[^/]+)/.+#\1/<redacted>#'
}

# The four roles the deploy scripts read, plus the ones the demo uses. These are
# anvil's own default accounts, which are derived from a mnemonic anvil prints on
# startup and which hold nothing anywhere else. Nothing here is a secret and no
# private key is written down, because the scripts sign through --unlocked.
load_accounts() {
  DEPLOYER="$(json_get "$ACCOUNTS_FILE" deployer)"
  PROPOSER="$(json_get "$ACCOUNTS_FILE" proposer)"
  GUARDIAN="$(json_get "$ACCOUNTS_FILE" guardian)"
  TREASURY="$(json_get "$ACCOUNTS_FILE" treasury)"
  SOLVER_A="$(json_get "$ACCOUNTS_FILE" solverA)"
  SOLVER_B="$(json_get "$ACCOUNTS_FILE" solverB)"
  export DEPLOYER PROPOSER GUARDIAN TREASURY SOLVER_A SOLVER_B
}

# Wangsit's scripts read and write deployments/<chainid>.json, and the fork keeps
# chain id 4663, so a fork run needs the path mainnet's committed record lives at.
# Park whatever is there, and put it back on every exit, failure included. A park
# left over from a run that was killed outright is restored first, because the
# file then sitting at the path is that run's fork record.
borrow_chain_record() {
  if [ -f "$PARKED_RECORD" ]; then
    warn "restoring the mainnet record parked by an earlier run that did not finish"
    mv -f "$PARKED_RECORD" "$CHAIN_RECORD"
  fi
  if [ -f "$CHAIN_RECORD" ]; then
    mv -f "$CHAIN_RECORD" "$PARKED_RECORD"
  fi
  CHAIN_RECORD_BORROWED=1
  trap return_chain_record EXIT
}

# Runs twice on a clean exit, once called and once from the trap. Without the
# flag the second run finds no park and deletes the record the first put back.
return_chain_record() {
  [ "${CHAIN_RECORD_BORROWED:-0}" = "1" ] || return 0
  CHAIN_RECORD_BORROWED=0
  if [ -f "$PARKED_RECORD" ]; then
    mv -f "$PARKED_RECORD" "$CHAIN_RECORD"
  else
    rm -f "$CHAIN_RECORD"
  fi
}

pinned_block() {
  [ -f "$PIN_FILE" ] || die "no pinned block. run: make pin"
  json_get "$PIN_FILE" block
}

fork_is_up() {
  cast chain-id --rpc-url "$FORK_RPC" >/dev/null 2>&1
}

require_fork() {
  fork_is_up || die "no fork answering at $FORK_RPC. run: make fork"
}

wait_for_fork() {
  local tries=${1:-60}
  for _ in $(seq 1 "$tries"); do
    if fork_is_up; then return 0; fi
    sleep 1
  done
  die "fork did not come up at $FORK_RPC"
}
