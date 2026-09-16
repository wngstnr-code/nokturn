#!/usr/bin/env bash
# Regenerates packages/shared/abi from the build output. Never edit those files by
# hand. The coordinator and the frontend both compile against them.
set -euo pipefail
cd "$(dirname "$0")/.."
out_dir="../packages/shared/abi"
mkdir -p "$out_dir"
rm -f "$out_dir"/*.json
forge build >/dev/null
count=0
for src_file in $(find src -name '*.sol' | sort); do
  base="$(basename "$src_file")"
  for name in $(grep -oE '^(abstract )?(contract|interface|library) [A-Za-z0-9_]+' "$src_file" | awk '{print $NF}'); do
    artifact="out/$base/$name.json"
    [ -f "$artifact" ] || continue
    abi="$(jq -c '.abi' "$artifact")"
    [ "$abi" = "[]" ] && continue
    echo "$abi" > "$out_dir/$name.json"
    count=$((count + 1))
  done
done
echo "exported $count abi files to $out_dir"
