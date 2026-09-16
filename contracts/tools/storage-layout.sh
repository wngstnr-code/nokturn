#!/usr/bin/env bash
# Writes the storage layout of every stateful contract to storage-layout.txt so an
# accidental slot reorder shows up in the diff. Settlement core is immutable, so a
# reorder that lands on mainnet cannot be patched, only redeployed.
#
# forge inspect reads the artifact, and a stale artifact returns an error while
# still exiting zero. An earlier version of this script wrote "(no layout)" on that
# path, which meant the gate passed by writing nothing for months. It now fails.
set -euo pipefail
cd "$(dirname "$0")/.."

forge build --force >/dev/null

out=storage-layout.txt
: > "$out"
found=0
for f in $(find src -name '*.sol' -not -path 'src/interfaces/*' | sort); do
  for c in $(grep -oE '^(abstract )?contract [A-Za-z0-9_]+' "$f" | awk '{print $NF}'); do
    layout="$(forge inspect "$c" storage-layout 2>&1)"
    case "$layout" in
      *"storage layout missing"*|*Error*)
        echo "forge inspect failed for $c:" >&2
        echo "$layout" >&2
        exit 1
        ;;
    esac
    echo "=== $c ($f)" >> "$out"
    echo "$layout" >> "$out"
    echo >> "$out"
    found=$((found + 1))
  done
done

if [ "$found" -eq 0 ]; then
  echo "no stateful contracts found, which means this gate is measuring nothing" >&2
  exit 1
fi
echo "wrote $out for $found contracts"
