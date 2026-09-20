#!/usr/bin/env python3
"""The gas table spek-teknis.md section 6 asks for, measured on chain rather than in a harness.

Both implementations expose the same selector, proved by tools/abi-match.sh, so the
same calldata goes to both and the comparison is like for like. Running it through
eth_estimateGas on a real endpoint means the input is charged the way the chain
charges it, which a staticcall inside forge does not do.

The batch is balanced pairs at one price, the cheapest shape the verifier ever sees.
A batch that routes to a venue or spans more tokens costs more, so these are a floor.
"""
import argparse
import subprocess
import sys

SIG = "verify(bytes,bytes,address[],uint256[],int256[],uint256[],uint256[],uint16,uint16)"
SIZES = (10, 50, 100, 200, 500)

USDG = "0x00000000000000000000000000000000000005D6"
NVDA = "0x00000000000000000000000000000000000004E7"


def batch(n):
    """Half the book buys the token with the quote asset and half sells it back, so it
    nets to nothing and no venue is touched. Mirrors ClearingVerifierGas.t.sol."""
    intents, executions, baselines = [], [], []
    for k in range(n):
        if k % 2 == 0:
            intents.append(f"{0:04x}{1:04x}{0:02x}{0:06x}{200 * 10**18:064x}{10**18:064x}")
            executions.append(f"{k:08x}{0:08x}{200 * 10**18:064x}{10**18:064x}")
            baselines.append(str(99 * 10**16))
        else:
            intents.append(f"{1:04x}{0:04x}{0:02x}{0:06x}{10**18:064x}{200 * 10**18:064x}")
            executions.append(f"{k:08x}{0:08x}{10**18:064x}{200 * 10**18:064x}")
            baselines.append(str(198 * 10**18))
    return "0x" + "".join(intents), "0x" + "".join(executions), baselines


def args_for(n):
    i, e, baselines = batch(n)
    prices = f"[{10**18},{200 * 10**18}]"
    return [i, e, f"[{USDG},{NVDA}]", prices, "[0,0]", prices, "[" + ",".join(baselines) + "]", "30", "3"]


def calldata_bytes(args):
    out = subprocess.run(["cast", "calldata", SIG, *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip())
    return (len(out.stdout.strip()) - 2) // 2


def estimate(rpc, to, args):
    """cast estimate takes the signature and its arguments rather than raw calldata,
    so the two are built the same way and cannot drift apart."""
    out = subprocess.run(
        ["cast", "estimate", to, SIG, *args, "--rpc-url", rpc], capture_output=True, text=True
    )
    if out.returncode != 0:
        return None, (out.stderr.strip() or out.stdout.strip()).replace("\n", " ")[:160]
    return int(out.stdout.strip()), None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--rpc", required=True)
    p.add_argument("--solidity", required=True, help="deployed ClearingVerifier.sol address")
    p.add_argument("--stylus", help="deployed stylus program address, omit to measure one side")
    args = p.parse_args()

    print(f"{'N':>5} {'calldata':>9} {'solidity':>10} {'stylus':>10} {'ratio':>7}")
    for n in SIZES:
        call = args_for(n)
        sol, sol_err = estimate(args.rpc, args.solidity, call)
        sty, sty_err = (None, None) if not args.stylus else estimate(args.rpc, args.stylus, call)

        cells = [f"{n:>5}", f"{calldata_bytes(call):>9}"]
        cells.append(f"{sol:>10}" if sol else f"{'error':>10}")
        cells.append(f"{sty:>10}" if sty else (f"{'-':>10}" if not args.stylus else f"{'error':>10}"))
        cells.append(f"{sol / sty:>7.2f}" if sol and sty else f"{'-':>7}")
        print(" ".join(cells))
        for err in (sol_err, sty_err):
            if err:
                print(f"      {err}", file=sys.stderr)


if __name__ == "__main__":
    main()
