#!/usr/bin/env bash
# Durability suite for the fork. Run it before a demo and after any restart.
#
# The one test it cannot do by itself is a real upstream outage, because
# anvil_setRpcUrl does not cut the fork backend. To check that, take the machine
# off the network and run this again. D3 will say how much still answers.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd node
require_fork
[ -f "$FORK_RECORD" ] || die "no $FORK_RECORD. run: make deploy"
exec node "$INFRA_DIR/scripts/check-fork.mjs"
