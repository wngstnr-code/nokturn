# verifier

The clearing checks in Rust, as the second implementation the differential gate in
`docs/rencana-uji.md` section 3 compares against `ClearingVerifier.sol`.

## Shape

`core` holds the checks. It has no state, no input or output, and no knowledge of
Stylus, so the same code answers the harness here and, if the benchmark supports it,
the deployed program later. Two things in it are reproduced rather than
reimplemented. The order of the checks, because two implementations that raise the
same errors on different inputs still disagree. And the arithmetic, because Solidity
reverts on a product that would wrap, so every multiplication is checked and every
overflow becomes the same panic.

`differential` runs both sides on the same input. The Solidity side executes inside
revm against the artifact forge already produced, because a million inputs is out of
reach over RPC. The comparison is the returned value and, on a revert, the raw
payload byte for byte.

## Running it

```
cd contracts && forge build
cd ../verifier && cargo run --release -p differential -- <cases> <seed>
```

Defaults are ten thousand cases and seed one. A disagreement prints the seed and the
case that produced it, so it is reproduced by repeating the seed rather than by
keeping a corpus of everything that passed.

## The input mix

Section 3 asks for forty percent random, thirty percent boundary, twenty percent
real mainnet cases and ten percent adversarial, and that is what the harness builds.

The mainnet slice is real. It is three thousand settled trade legs between the four
allowlist v1.0 stock tokens and USDG on chain 4663, pulled from Dune query 8768375
with the raw amounts intact, so the six decimal side and the eighteen decimal side
arrive exactly as they did onchain. The harness refuses to start without that file
rather than filling the slice with generated numbers, because a gate that reports a
mix it did not use is worse than a gate that stops.

## What the error selectors rest on

The core writes its thirteen selectors out as bytes rather than hashing them, so it
carries no hash dependency. The harness checks every one against the compiled
Solidity ABI before it starts, and refuses to run on a mismatch. A wrong byte fails
the gate instead of hiding inside it.

## Stylus

Nothing here depends on the Stylus port landing. `pitch.md` puts it in v1.1,
conditional on the benchmark, and the measurement in `pertanyaan-terbuka.md` RONDE 7
is the reason that condition is worth keeping. The verifier address is `immutable` in
`Settlement.sol`, so moving to Stylus means a new Settlement rather than an allowlist
change.
