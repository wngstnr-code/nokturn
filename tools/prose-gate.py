#!/usr/bin/env python3
"""Enforces CLAUDE.md section 11.4 and 11.6 on everything written from now on.

The research archive under docs/ predates both rules and is exempt by decision of
the project owner, 14 September 2026, so it is never scanned. Runs the same way on
macOS and in CI, which BSD grep cannot do because it has no -P.
"""
import re
import subprocess
import sys
from pathlib import Path

PROSE_SUFFIXES = {".md", ".sol", ".ts", ".tsx", ".rs", ".yml", ".yaml"}
SURFACE_SUFFIXES = {".sol", ".ts", ".tsx", ".rs"}
EXCLUDED_DIRS = {"docs", "lib", "node_modules", ".git", "out", "cache", "broadcast"}

# Written 1 August 2026 as research artifacts and committed unchanged on the day the
# rules landed, so they belong to the frozen archive exactly like docs. Listed one by
# one on purpose, so a README written from now on inside data still gets scanned.
EXEMPT_FILES = {
    Path("data/dune-queries/README.md"),
    Path("data/nyse-calendar/README.md"),
}

# An en dash between two digits is a range, not a connector, so it stays allowed.
DASH = re.compile(r"—|(?<![0-9])–|–(?![0-9])")
# Arrows and box drawing stay allowed, wireframes use them.
EMOJI = re.compile(r"[\U0001F300-\U0001FAFF☀-➿⬀-⯿️]")


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=True
    ).stdout.splitlines()
    for rel in out:
        path = Path(rel)
        if EXCLUDED_DIRS & set(path.parts) or path in EXEMPT_FILES:
            continue
        yield path


def scan():
    failures = []
    for path in tracked_files():
        if path.suffix not in PROSE_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError):
            continue
        is_surface = path.suffix in SURFACE_SUFFIXES or path.name == "README.md"
        for number, line in enumerate(text.splitlines(), 1):
            if DASH.search(line):
                failures.append((path, number, "em dash or connector en dash", line.strip()))
            if is_surface and EMOJI.search(line):
                failures.append((path, number, "emoji on the repo surface", line.strip()))
    return failures


def main():
    failures = scan()
    for path, number, rule, line in failures:
        print(f"{path}:{number}: {rule}\n    {line[:120]}")
    if failures:
        print(f"\n{len(failures)} violations")
        return 1
    print("prose gate passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
