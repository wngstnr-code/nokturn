#!/usr/bin/env python3
"""Copies mainnet 4663 Chainlink rounds into the MirrorFeed contracts on 46630.

Each mirror names its own mainnet source on chain, so this script never decides
which feed goes where. It reads source(), checks the decimals agree, and copies
any round newer than the one already mirrored, with the mainnet timestamp intact.
After a push it calls sync on every pool that prices against that feed, which is
the only way a testnet pool price moves apart from a swap.

Nothing here can choose a price. MirrorFeed refuses a round that is not newer, a
timestamp ahead of the testnet clock, and any caller but its operator, and the
pool takes its price from the feeds alone. parameter.md section 10.6.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

MAINNET = 4663
TESTNET = 46630

ROUND = "latestRoundData()(uint80,int256,uint256,uint256,uint80)"


def cast(args, rpc):
    out = subprocess.run(
        ["cast", *args, "--rpc-url", rpc], capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or out.stdout.strip())
    return out.stdout


def call(rpc, address, signature, *params):
    """One value per line, with the human annotation cast appends dropped."""
    raw = cast(["call", address, signature, *map(str, params)], rpc)
    return [line.split(" ")[0] for line in raw.strip().splitlines()]


def chain_id(rpc):
    return int(cast(["chain-id"], rpc).strip())


def block_time(rpc):
    return int(cast(["block", "latest", "--field", "timestamp"], rpc).strip())


def send(rpc, account, password_file, address, signature, *params):
    argv = ["send", address, signature, *map(str, params), "--account", account]
    if password_file:
        argv += ["--password-file", password_file]
    cast(argv, rpc)


class Mirror:
    def __init__(self, address, mainnet, testnet):
        self.address = address
        self.source = call(testnet, address, "source()(address)")[0]
        mine = int(call(testnet, address, "decimals()(uint8)")[0])
        theirs = int(call(mainnet, self.source, "decimals()(uint8)")[0])
        if mine != theirs:
            raise SystemExit(
                f"{address} answers {mine} decimals and its source {self.source} answers {theirs}. "
                "A mirror that rescales is not a mirror, redeploy it."
            )

    def pending(self, mainnet, testnet):
        """The mainnet round to copy, or None when the mirror is already current."""
        source_round, answer, _, updated_at, _ = call(mainnet, self.source, ROUND)
        latest = int(call(testnet, self.address, "latestRound()(uint80)")[0])
        mirrored = int(call(testnet, self.address, "sourceRoundOf(uint80)(uint80)", latest)[0])
        if int(source_round) <= mirrored:
            return None
        return int(source_round), int(answer), int(updated_at)


def load(path):
    record = json.loads(Path(path).read_text())
    return record["quoteFeed"], record["feeds"], record["pools"]


def initialized(testnet, pool):
    return int(call(testnet, pool, "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)")[0]) != 0


def once(args, quote, stocks, pools):
    now = block_time(args.testnet_rpc)
    pushed = set()

    for mirror in [quote, *stocks]:
        round_ = mirror.pending(args.mainnet_rpc, args.testnet_rpc)
        if round_ is None:
            continue
        source_round, answer, updated_at = round_
        if updated_at > now:
            # The two chains keep separate clocks. The next pass will take it.
            print(f"{mirror.address} round {source_round} is {updated_at - now}s ahead of 46630, later")
            continue
        print(f"{mirror.address} <- {mirror.source} round {source_round} answer {answer} at {updated_at}")
        if not args.dry_run:
            send(args.testnet_rpc, args.account, args.password_file, mirror.address,
                 "push(uint80,int256,uint256)", source_round, answer, updated_at)
        pushed.add(mirror.address)

    for k, pool in enumerate(pools):
        if quote.address in pushed or stocks[k].address in pushed or not initialized(args.testnet_rpc, pool):
            print(f"sync {pool}")
            if not args.dry_run:
                send(args.testnet_rpc, args.account, args.password_file, pool, "sync()")


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--mainnet-rpc", default=os.environ.get("NOKTURN_RPC_MAINNET"))
    p.add_argument("--testnet-rpc", default=os.environ.get("NOKTURN_RPC_TESTNET"))
    p.add_argument("--fixtures", default=str(ROOT / "deployments" / f"{TESTNET}-fixtures.json"))
    p.add_argument("--account", help="cast wallet account name of the mirror operator")
    p.add_argument("--password-file", help="keystore password file, for running unattended")
    p.add_argument("--interval", type=int, default=60)
    p.add_argument("--once", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="print what would be sent and send nothing")
    args = p.parse_args()

    if not args.mainnet_rpc or not args.testnet_rpc:
        p.error("both RPCs are needed, from the flags or NOKTURN_RPC_MAINNET and NOKTURN_RPC_TESTNET")
    if not args.dry_run and not args.account:
        p.error("sending needs --account, because only the operator may push")
    if chain_id(args.mainnet_rpc) != MAINNET:
        p.error(f"--mainnet-rpc is not chain {MAINNET}")
    if chain_id(args.testnet_rpc) != TESTNET:
        p.error(f"--testnet-rpc is not chain {TESTNET}")

    quote_feed, feeds, pools = load(args.fixtures)
    quote = Mirror(quote_feed, args.mainnet_rpc, args.testnet_rpc)
    stocks = [Mirror(f, args.mainnet_rpc, args.testnet_rpc) for f in feeds]

    while True:
        try:
            once(args, quote, stocks, pools)
        except RuntimeError as err:
            # One failed read or send is not a reason to stop mirroring the rest of
            # the day. The feed going stale on 46630 is the visible symptom.
            print(f"pass failed, {err}", file=sys.stderr)
            if args.once:
                return 1
        if args.once:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
