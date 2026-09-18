#!/usr/bin/env bash
# Proves the Stylus program exposes the same two functions ClearingVerifier.sol
# does, by selector rather than by eye. A parameter that arrives as uint8[] instead
# of bytes reads the same in a diff and is a different function onchain.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
solidity="$here/../../contracts/out/ClearingVerifier.sol/ClearingVerifier.json"

if [ ! -f "$solidity" ]; then
  echo "abi-match: run forge build in contracts first" >&2
  exit 1
fi

abi="$(cd "$here/../stylus" && cargo stylus export-abi 2>/dev/null)"

python3 - "$solidity" <<PY
import json, re, sys

abi = """$abi"""
solidity = json.load(open(sys.argv[1]))["methodIdentifiers"]

found = {}
for line in abi.splitlines():
    m = re.match(r"\s*function (\w+)\((.*?)\) external (\w+)", line)
    if not m:
        continue
    name, args, mutability = m.groups()
    types = []
    for arg in filter(None, (a.strip() for a in args.split(","))):
        types.append(arg.split()[0])
    found[f"{name}({','.join(types)})"] = mutability

failures = []
for signature in solidity:
    if signature not in found:
        failures.append(f"the stylus program does not expose {signature}")
    elif found[signature] != "pure":
        failures.append(f"{signature} is {found[signature]} in stylus and pure in solidity")
for signature in found:
    if signature not in solidity:
        failures.append(f"the stylus program exposes {signature}, which the contract does not")

if failures:
    for f in failures:
        print(f"abi-match: {f}")
    sys.exit(1)

for signature, selector in sorted(solidity.items()):
    print(f"0x{selector} {signature}")
print(f"{len(solidity)} functions match")
PY
