#!/usr/bin/env python3
"""The watch loop of threat-model.md section 6.1, and the two signals that need history.

Five of the six signals are pure functions of chain state and live in
script/Monitor.s.sol, which is where the pause decision is made. The two that count
occurrences over time cannot be, so they are here, and neither of them ever pauses.

The split is not tidiness. A pause that depends on a local journal is a pause that
depends on the journal being right, and this endpoint serves logs far back but state
only for the last twenty to forty thousand blocks. parameter.md section 8.3.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Measured 20 September 2026 against robinhood.drpc.org, both networks. Logs answer
# at least sixty million blocks back, but one query may span no more than a hundred
# and one blocks whatever the filter is and however few entries match. The endpoint
# refuses wider ones with a message about ten thousand blocks, which is not what it
# is actually measuring. parameter.md section 8.3.
MAX_LOG_SPAN = 101

# Roughly ten minutes of chain. Past this the monitor stops trying to read its way
# back and says how much it missed, because a hundred block window means catching up
# on an hour is six hundred round trips and the live signal is what matters.
MAX_CATCHUP_BLOCKS = 6_000

WINDOW_SECONDS = 24 * 60 * 60

AUCTION_EXTENDED = "AuctionExtended(uint64,uint8,uint16)"
BATCH_PASSTHROUGH = "BatchPassthrough(uint64,uint256,string)"

MAX_EXTENSIONS = 3
FAILED_FINALIZE_PER_DAY = 2
FAILED_FINALIZE_REASON = "winner never finalized"


def cast(args, rpc):
    out = subprocess.run(
        ["cast", *args, "--rpc-url", rpc], capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or out.stdout.strip())
    return out.stdout


def head_block(rpc):
    return int(cast(["block-number"], rpc).strip())


def logs(rpc, address, signature, start, end):
    found = []
    while start <= end:
        stop = min(start + MAX_LOG_SPAN - 1, end)
        raw = cast(
            [
                "logs",
                "--from-block", str(start),
                "--to-block", str(stop),
                "--address", address,
                signature,
                "--json",
            ],
            rpc,
        )
        found.extend(json.loads(raw or "[]"))
        start = stop + 1
    return found


def state_check(rpc, broadcast, account):
    """Runs the solidity half and returns its verdict.

    A run that died on its way to a conclusion has no verdict line, and that is
    read as a failure rather than as quiet. An all clear has to be stated.
    """
    entry = "pauseIfBreached()" if broadcast else "run()"
    argv = [
        "forge", "script", "script/Monitor.s.sol:Monitor",
        "--sig", entry,
        "--rpc-url", rpc,
    ]
    if broadcast:
        argv += ["--broadcast", "--account", account]

    out = subprocess.run(argv, capture_output=True, text=True, check=False, cwd=ROOT)
    body = out.stdout + out.stderr
    for line in body.splitlines():
        if line.strip().startswith("nokturn monitor verdict:"):
            return line.strip().split(":", 1)[1].strip(), body
    return None, body


def history_check(rpc, settlement, house, since, until, journal):
    """Counts the two signals that only mean something over time.

    The counts live in the journal rather than being re derived from logs on every
    pass, because a hundred block window makes a day of history eight thousand round
    trips. A monitor that has just started therefore has a partial window, and that
    is stated rather than hidden.
    """
    findings = []
    now = time.time()

    for entry in logs(rpc, house, AUCTION_EXTENDED, since, until):
        topics = entry["topics"]
        count = int(topics[2], 16) if len(topics) > 2 else int(entry["data"][:66], 16)
        if count >= MAX_EXTENSIONS:
            findings.append(
                f"M6 alert auction {int(topics[1], 16)} used every extension, "
                "so its price sat at the collar"
            )

    for entry in logs(rpc, settlement, BATCH_PASSTHROUGH, since, until):
        if FAILED_FINALIZE_REASON in decode_reason(entry["data"]):
            journal.append(now)

    journal[:] = [at for at in journal if now - at < WINDOW_SECONDS]
    if len(journal) >= FAILED_FINALIZE_PER_DAY:
        findings.append(
            f"M7 alert {len(journal)} batches went unfinalized inside the last day"
        )

    return findings


def decode_reason(data):
    """The reason is the only string in the payload, so it is read rather than decoded.

    A full abi decode would mean another subprocess per hit for one field that is
    already sitting there as ascii.
    """
    raw = bytes.fromhex(data[2:] if data.startswith("0x") else data)
    return "".join(chr(b) if 32 <= b < 127 else " " for b in raw)


def once(args, state):
    rpc = args.rpc
    until = head_block(rpc)
    since = state.get("block")
    skipped = 0
    if since is None:
        since = until
    elif until - since > MAX_CATCHUP_BLOCKS:
        skipped = until - since - MAX_CATCHUP_BLOCKS
        since = until - MAX_CATCHUP_BLOCKS

    verdict, body = state_check(rpc, args.broadcast, args.account)
    if verdict is None:
        print("monitor: the state pass produced no verdict", file=sys.stderr)
        print(body, file=sys.stderr)
        return 2, state

    for line in body.splitlines():
        if line.startswith("  ") or " PAUSE " in line or " alert " in line:
            print(line.rstrip())

    journal = state.get("failedFinalize", [])
    for finding in history_check(rpc, args.settlement, args.house, since, until, journal):
        print(finding)

    if skipped:
        print(f"monitor: {skipped} blocks were never read, the loop had fallen behind")

    state = {"block": until + 1, "failedFinalize": journal}
    print(f"monitor: {verdict}, blocks {since} to {until}")
    return (1 if verdict == "pause" else 0), state


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--rpc", default=os.environ.get("NOKTURN_RPC_MAINNET"))
    p.add_argument("--chain-id", default="4663")
    p.add_argument("--interval", type=int, default=60)
    p.add_argument("--once", action="store_true")
    p.add_argument("--state", default=str(ROOT / ".monitor-state.json"))
    p.add_argument(
        "--broadcast",
        action="store_true",
        help="let the monitor call pause. Needs --account, and a key that is warm.",
    )
    p.add_argument("--account", help="cast wallet account name for the guardian key")
    args = p.parse_args()

    if not args.rpc:
        p.error("no rpc. Pass --rpc or set NOKTURN_RPC_MAINNET in the repo root .env")
    if args.broadcast and not args.account:
        p.error("--broadcast needs --account, because pause is signed by the guardian")

    record = json.loads((ROOT / "deployments" / f"{args.chain_id}.json").read_text())
    args.settlement = record["settlement"]
    args.house = record["auctionHouse"]

    journal = Path(args.state)
    state = json.loads(journal.read_text()) if journal.exists() else {}

    while True:
        try:
            code, state = once(args, state)
            journal.write_text(json.dumps(state))
        except RuntimeError as err:
            print(f"monitor: {err}", file=sys.stderr)
            code = 2
        if args.once:
            return code
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
