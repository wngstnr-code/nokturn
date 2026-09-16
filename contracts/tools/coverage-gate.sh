#!/usr/bin/env bash
# Fails when line coverage on any core contract drops below 95 percent.
# Interfaces and libraries without branches are skipped, they have nothing to cover.
set -euo pipefail
report="${1:?usage: coverage-gate.sh <forge coverage summary file> [skip-substring ...]}"
shift || true
skips=("$@")
threshold=95

# An empty or truncated report used to pass silently. A gate that measures
# nothing must not look like a gate that passes.
if [ ! -s "$report" ]; then
  echo "coverage report is empty, so the gate measured nothing" >&2
  exit 1
fi
if ! grep -q "src/" "$report"; then
  echo "coverage report lists no src files, so the gate measured nothing" >&2
  exit 1
fi
failed=0
while IFS='|' read -r _ file lines _; do
  case "$file" in
    *src/*.sol*) ;;
    *) continue ;;
  esac
  case "$file" in
    *src/interfaces/*|*src/types/*) continue ;;
  esac
  skipped=0
  for skip in ${skips[@]+"${skips[@]}"}; do
    case "$file" in
      *"$skip"*)
        echo "skipping $skip, covered by the nightly fork run instead"
        skipped=1
        ;;
    esac
  done
  [ "$skipped" -eq 1 ] && continue
  pct="$(echo "$lines" | grep -oE '[0-9]+\.[0-9]+' | head -1 || true)"
  [ -z "$pct" ] && continue
  if awk "BEGIN{exit !($pct < $threshold)}"; then
    echo "coverage below $threshold percent: $file at $pct"
    failed=1
  fi
done < "$report"
[ "$failed" -eq 0 ] && echo "coverage gate passed"
exit "$failed"
