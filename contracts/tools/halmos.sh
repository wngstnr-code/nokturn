#!/usr/bin/env bash
# Symbolic run over the clearing predicates, per rencana-uji.md section 4.
#
# The three flags are not decoration.
#
# FOUNDRY_PROFILE=halmos emits the solidity AST into out/, which is how halmos
# finds test functions at all. The default profile leaves it out because it
# roughly doubles the size of the build.
#
# Both profiles write to the same out/, so a local run that already built without
# the AST leaves forge reporting no files changed and halmos reporting no tests
# found. The forced build below is what makes this work on a laptop. CI checks out
# clean and would never have shown it.
#
# --loop 8 covers the six width comparison, which walks five adjacent pairs. The
# default bound of two would stop partway and report the unexplored paths as a
# failure rather than as a gap.
#
# The three contracts are run one at a time rather than by a shared prefix, so
# that a new proof file has to be named here to be gated. A glob would let one
# arrive unproved and unnoticed.
#
# --solver-timeout-assertion 300000 is what the limit monotonicity proof needs.
# It is a product of two unknown 128 bit values and z3 takes about 170 seconds on
# it. At the default of one second it reports a timeout, which reads like a
# counterexample and is not one.
set -euo pipefail

cd "$(dirname "$0")/.."

FOUNDRY_PROFILE=halmos forge build --force >/dev/null

for contract in ClearingMathProofs AuctionMathProofs SessionProofs; do
  echo "== $contract"
  FOUNDRY_PROFILE=halmos halmos \
    --contract "$contract" \
    --function testFuzz \
    --loop 8 \
    --solver-timeout-assertion 300000 \
    "$@"
done
