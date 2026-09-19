#!/usr/bin/env bash
# Symbolic run over the clearing predicates, per rencana-uji.md section 4.
#
# The three flags are not decoration.
#
# FOUNDRY_PROFILE=halmos emits the solidity AST into out/, which is how halmos
# finds test functions at all. The default profile leaves it out because it
# roughly doubles the size of the build.
#
# --loop 8 covers the six width comparison, which walks five adjacent pairs. The
# default bound of two would stop partway and report the unexplored paths as a
# failure rather than as a gap.
#
# --solver-timeout-assertion 300000 is what the limit monotonicity proof needs.
# It is a product of two unknown 128 bit values and z3 takes about 170 seconds on
# it. At the default of one second it reports a timeout, which reads like a
# counterexample and is not one.
set -euo pipefail

cd "$(dirname "$0")/.."

FOUNDRY_PROFILE=halmos halmos \
  --contract ClearingMathProofs \
  --function testFuzz \
  --loop 8 \
  --solver-timeout-assertion 300000 \
  "$@"
