#!/usr/bin/env bash
# Echidna over the invariants, per rencana-uji.md section 1. It is a second engine
# on the same properties foundry drives, and it is a different engine rather than
# a second opinion. Echidna builds its values from a dictionary it mines out of the
# source, mutates whole call sequences rather than single arguments, and shrinks
# differently, so it reaches shapes the foundry campaigns do not.
#
# There are no cheatcodes here. Echidna has none, so the targets carry their own
# session table rather than reading the fixture, intent owners are contracts that
# approve Permit2 themselves, and a batch is chosen to fit the clock rather than
# the clock being moved to fit a batch.
#
# --foundry-compile-all is not optional. Without it crytic-compile builds the
# project the way forge does for a release and skips test/ entirely, and echidna
# then reports that the contract does not exist.
set -euo pipefail
cd "$(dirname "$0")/.."

run() {
  echo "== $1"
  echidna . --contract "$1" --config "test/echidna/$2" \
    --crytic-args "--foundry-compile-all" "${@:3}"
}

run EchidnaClearing echidna.yaml "$@"
run EchidnaSettlement stateful.yaml "$@"
run EchidnaSession stateful.yaml "$@"
run EchidnaMandate stateful.yaml "$@"
