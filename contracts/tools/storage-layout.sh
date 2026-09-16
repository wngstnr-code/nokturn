#!/usr/bin/env bash
# Writes the storage layout of every stateful contract to storage-layout.txt so an
# accidental slot reorder shows up in the diff. Settlement core is immutable, so a
# reorder that lands on mainnet cannot be patched, only redeployed.
set -euo pipefail
cd "$(dirname "$0")/.."
out=storage-layout.txt
: > "$out"
for f in $(find src -name '*.sol' -not -path 'src/interfaces/*' | sort); do
  for c in $(grep -oE '^(abstract )?contract [A-Za-z0-9_]+' "$f" | awk '{print $NF}'); do
    echo "=== $c ($f)" >> "$out"
    forge inspect "$c" storage-layout >> "$out" 2>/dev/null || echo "(no layout)" >> "$out"
    echo >> "$out"
  done
done
echo "wrote $out"
