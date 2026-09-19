#!/usr/bin/env python3
"""The guardian has exactly one power, and this is what keeps it that way.

parameter.md section 8 says the guardian can pause and can do nothing else. A
solver can prove what the code does today. It cannot prove that nobody adds a
second guardian-only function next month, because that is a statement about
source that has not been written, so the check lives here and runs on every push.

The rule is narrow on purpose. A comparison between a caller and the guardian
address is a privilege, and there is room for exactly one, inside Guarded.pause.
Anything else is either a new power or a copy of the old one, and both should be
argued for rather than merged quietly.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOME = ROOT / "src" / "Guarded.sol"

# A privilege check reads the guardian slot and compares it to a caller.
CHECK = re.compile(r"msg\.sender\s*[!=]=\s*guardian|guardian\s*[!=]=\s*msg\.sender")

WRITE = re.compile(r"\bguardian\s*=")


def main() -> int:
    findings = []

    for path in sorted((ROOT / "src").rglob("*.sol")):
        text = path.read_text()
        for number, line in enumerate(text.splitlines(), 1):
            if CHECK.search(line) and path != HOME:
                findings.append(f"{path.relative_to(ROOT)}:{number}: guardian is checked outside Guarded.sol")
            if WRITE.search(line) and path != HOME:
                findings.append(f"{path.relative_to(ROOT)}:{number}: guardian is assigned outside Guarded.sol")

    text = HOME.read_text()
    checks = [n for n, line in enumerate(text.splitlines(), 1) if CHECK.search(line)]
    if len(checks) != 1:
        findings.append(f"src/Guarded.sol: expected one guardian check, found {len(checks)} at lines {checks}")

    if "function unpause" in text:
        findings.append("src/Guarded.sol: an unpause exists, and parameter.md 8.1 says there is none")


    if findings:
        print("guardian gate failed")
        for line in findings:
            print("  " + line)
        return 1

    print("guardian gate passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
