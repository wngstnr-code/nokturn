#!/usr/bin/env bash
# Fails when line coverage on any core contract drops below 95 percent.
# Interfaces and libraries without branches are skipped, they have nothing to cover.
set -euo pipefail
report="${1:?usage: coverage-gate.sh <forge coverage summary file>}"
threshold=95
failed=0
while IFS='|' read -r _ file lines _; do
  case "$file" in
    *src/*.sol*) ;;
    *) continue ;;
  esac
  case "$file" in
    *src/interfaces/*|*src/types/*) continue ;;
  esac
  pct="$(echo "$lines" | grep -oE '[0-9]+\.[0-9]+' | head -1 || true)"
  [ -z "$pct" ] && continue
  if awk "BEGIN{exit !($pct < $threshold)}"; then
    echo "coverage below $threshold percent: $file at $pct"
    failed=1
  fi
done < "$report"
[ "$failed" -eq 0 ] && echo "coverage gate passed"
exit "$failed"
