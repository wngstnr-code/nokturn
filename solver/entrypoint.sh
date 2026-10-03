#!/bin/sh
# NOKTURN_ROLE picks what this container runs.
#
#   solver   the solver alone (default)
#   keeper   the auction keeper alone
#   both     both in one container, for a host that allows one service here
#
# With both, the container exits as soon as either process does, so the host
# restarts the pair rather than leaving one of them dead behind a live service.

set -eu

case "${NOKTURN_ROLE:-solver}" in
  solver) exec node solver/src/index.ts --run ;;
  keeper) exec node solver/src/keeper.ts --profile b ;;
  both)
    node solver/src/index.ts --run &
    solver=$!
    node solver/src/keeper.ts --profile b &
    keeper=$!
    trap 'kill "$solver" "$keeper" 2>/dev/null; exit 143' TERM INT
    while kill -0 "$solver" 2>/dev/null && kill -0 "$keeper" 2>/dev/null; do
      sleep 5
    done
    kill -0 "$solver" 2>/dev/null && echo "keeper exited, stopping the solver too" >&2
    kill -0 "$keeper" 2>/dev/null && echo "solver exited, stopping the keeper too" >&2
    kill "$solver" "$keeper" 2>/dev/null || true
    exit 1
    ;;
  *) echo "NOKTURN_ROLE is ${NOKTURN_ROLE}, not solver, keeper or both" >&2; exit 1 ;;
esac
