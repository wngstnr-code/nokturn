#!/usr/bin/env bash
# The whole backend stack through infra/docker-compose.yml.
#
#   stack.sh up | down | logs
#
# up builds what changed and waits for every service to report healthy. down
# removes every container and volume the stack made, the database included.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
docker info >/dev/null 2>&1 || die "docker is not answering. start Docker Desktop first"

COMPOSE=(docker compose -f "$INFRA_DIR/docker-compose.yml" -p nokturn)

case "${1:-}" in
  up)
    [ -f "$REPO_ROOT/.env" ] || die "no .env at the repo root. copy .env.example to .env and set NOKTURN_RPC_MAINNET to an archive RPC for chain 4663, docs/runbook-backend.md section 1"
    grep -q '^NOKTURN_RPC_MAINNET=' "$REPO_ROOT/.env" || die ".env sets no NOKTURN_RPC_MAINNET. the fork needs an archive RPC, docs/runbook-backend.md section 1"
    if fork_is_up; then
      die "something already answers at $FORK_RPC. stop make fork first, the stack runs its own anvil"
    fi
    "${COMPOSE[@]}" up -d --build --wait anvil postgres indexer api solver-a solver-b
    log "stack up. api on http://127.0.0.1:${NOKTURN_API_PORT:-3000}, fork on $FORK_RPC. next: make demo"
    ;;
  down)
    "${COMPOSE[@]}" down --volumes --remove-orphans
    ;;
  logs)
    exec "${COMPOSE[@]}" logs --follow --tail 200
    ;;
  *)
    die "usage: stack.sh up | down | logs"
    ;;
esac
