#!/usr/bin/env bash
# The indexer's Postgres, through infra/docker-compose.yml.
#
#   db.sh up | down | reset
#
# reset deletes the volume and every indexed row with it. On a terminal it asks
# first. Without one, it needs NOKTURN_DB_RESET=yes, so a script cannot wipe the
# database by accident.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd docker
docker info >/dev/null 2>&1 || die "docker is not answering. start Docker Desktop first"

COMPOSE=(docker compose -f "$INFRA_DIR/docker-compose.yml" -p nokturn)

PORT="${NOKTURN_DB_PORT:-5433}"

case "${1:-}" in
  up)
    "${COMPOSE[@]}" up -d --wait postgres
    log "postgres on 127.0.0.1:$PORT, NOKTURN_DATABASE_URL=postgres://nokturn:nokturn@127.0.0.1:$PORT/nokturn"
    ;;
  down)
    "${COMPOSE[@]}" stop postgres
    ;;
  reset)
    if [ -t 0 ]; then
      read -r -p "delete the indexer database volume and every row in it? type yes: " answer
      [ "$answer" = "yes" ] || die "left as it was"
    elif [ "${NOKTURN_DB_RESET:-}" != "yes" ]; then
      die "not a terminal. set NOKTURN_DB_RESET=yes to reset without asking"
    fi
    "${COMPOSE[@]}" down -v
    log "volume removed. run: make db-up"
    ;;
  *)
    die "usage: db.sh up | down | reset"
    ;;
esac
