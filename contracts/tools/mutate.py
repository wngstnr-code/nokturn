#!/usr/bin/env python3
"""Mutation testing for the core contracts, per rencana-uji.md section 5.

The question this asks is not whether the code is right. It is whether the tests
would notice if it stopped being right. A mutant is a single character level
change to one operator or one constant. If the suite still passes, that mutant
survived, and a survivor is a hole in the tests rather than a bug in the code.

Survivors are printed one by one with the line they sit on, because the standard
this repo holds itself to is explaining each of them rather than reporting a
percentage and moving on. A survivor that is genuinely equivalent goes in
tools/mutants-explained.txt with its reason and stops counting against the score.
"""

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

# Each entry is a pattern and what it becomes. The patterns are deliberately
# narrow, because a mutation that does not compile teaches nothing and still
# costs a full build.
OPERATORS = [
    (r"(?<![<>=!+\-*/&|^])>=(?!=)", ">"),
    (r"(?<![<>=!+\-*/&|^])<=(?!=)", "<"),
    (r"(?<![<>=!+\-*/&|^])>(?![=>])", ">="),
    (r"(?<![<>=!+\-*/&|^])<(?![=<])", "<="),
    (r"(?<![<>=!+\-*/&|^])==(?!=)", "!="),
    (r"(?<![<>=!+\-*/&|^])!=(?!=)", "=="),
    (r"(?<![+\-*/%=<>!&|^])\+(?![+=])", "-"),
    (r"(?<![+\-*/%=<>!&|^])-(?![-=>])", "+"),
    (r"(?<![+\-*/%=<>!&|^])\*(?![*=/])", "/"),
    (r"&&", "||"),
    (r"\|\|", "&&"),
]

# Lines carrying these are skipped. A mutation inside a pragma, an import or a
# type declaration changes what compiles rather than what runs.
SKIP_LINE = re.compile(r"^\s*(//|/\*|\*|pragma|import|using|error |event |struct |enum )")


def strip_noise(line: str) -> str:
    """Blank out comments and string literals so no mutation lands inside one."""
    out = []
    in_string = None
    k = 0
    while k < len(line):
        char = line[k]
        if in_string:
            out.append(" ")
            if char == in_string and line[k - 1] != "\\":
                in_string = None
            k += 1
            continue
        if char in "\"'":
            in_string = char
            out.append(" ")
            k += 1
            continue
        if line[k : k + 2] == "//":
            out.append(" " * (len(line) - k))
            break
        out.append(char)
        k += 1
    return "".join(out)


def mutants_for(path: Path):
    source = path.read_text().splitlines()
    found = []
    in_block_comment = False
    for number, line in enumerate(source):
        stripped = line.strip()
        if in_block_comment:
            if "*/" in stripped:
                in_block_comment = False
            continue
        if stripped.startswith("/*"):
            if "*/" not in stripped:
                in_block_comment = True
            continue
        if SKIP_LINE.match(line):
            continue
        scannable = strip_noise(line)
        for pattern, replacement in OPERATORS:
            for match in re.finditer(pattern, scannable):
                found.append((number, match.start(), match.group(0), replacement))
    return source, found


def apply(source, number, column, original, replacement):
    line = source[number]
    return line[:column] + replacement + line[column + len(original) :]


def load_explained(path: Path):
    if not path.exists():
        return {}
    explained = {}
    for raw in path.read_text().splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        key, _, reason = raw.partition("|")
        explained[key.strip()] = reason.strip()
    return explained


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("targets", nargs="+", help="contract sources to mutate")
    parser.add_argument("--threshold", type=float, default=90.0)
    parser.add_argument("--explained", default="tools/mutants-explained.txt")
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()

    explained = load_explained(Path(args.explained))
    command = [
        "forge",
        "test",
        "--no-match-path",
        "test/{fork,invariant}/*",
    ]

    killed = 0
    survived = []
    skipped = []
    uncompilable = 0
    started = time.time()

    for target in args.targets:
        path = Path(target)
        source, found = mutants_for(path)
        original_text = path.read_text()
        print(f"{path}: {len(found)} mutants", flush=True)

        for number, column, original, replacement in found:
            key = f"{path}:{number + 1}:{column}:{original}>{replacement}"
            if key in explained:
                skipped.append((key, explained[key]))
                continue

            mutated = list(source)
            mutated[number] = apply(source, number, column, original, replacement)
            path.write_text("\n".join(mutated) + "\n")
            try:
                result = subprocess.run(
                    command, capture_output=True, text=True, timeout=args.timeout
                )
                output = result.stdout + result.stderr
                if "Compiler run failed" in output or "Error: " in output and result.returncode != 0 and "FAIL" not in output:
                    uncompilable += 1
                elif result.returncode == 0:
                    survived.append((key, source[number].strip()))
                    print(f"  SURVIVED {key}", flush=True)
                else:
                    killed += 1
            except subprocess.TimeoutExpired:
                # A mutant that hangs the suite is caught, since the suite
                # noticed it. An infinite loop is a failure like any other.
                killed += 1
            finally:
                path.write_text(original_text)

    total = killed + len(survived)
    score = 100.0 * killed / total if total else 100.0
    elapsed = time.time() - started

    print()
    print(f"killed {killed}, survived {len(survived)}, not compilable {uncompilable}")
    print(f"explained and skipped {len(skipped)}")
    print(f"score {score:.1f} percent over {total} scoring mutants in {elapsed:.0f}s")

    if survived:
        print()
        print("survivors, each of which is a hole in the tests until explained:")
        for key, line in survived:
            print(f"  {key}")
            print(f"    {line}")

    if score < args.threshold:
        print(f"\nbelow the threshold of {args.threshold} percent")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
