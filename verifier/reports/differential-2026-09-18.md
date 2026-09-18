# Differential report, 18 September 2026

Required by `docs/rencana-uji.md` section 3, which asks for a million inputs, zero
differences, and the report committed to the repo.

One million inputs, seed 1, in 8.3 seconds. The Solidity side is
`contracts/src/ClearingVerifier.sol` executed inside revm against the artifact
forge produced. The Rust side is `verifier/core`. Each input is compared on the
returned value and, on a revert, on the raw payload byte for byte.

The mix is the one section 3 specifies. Forty percent random, thirty percent
boundary, twenty percent real mainnet cases, ten percent adversarial. The mainnet
slice is three thousand settled trade legs between the four allowlist v1.0 stock
tokens and USDG on chain 4663, from Dune query 8768375, with the raw amounts
intact.

All thirteen custom errors are reached, along with the arithmetic panic Solidity
raises on a product that would wrap, and accepted batches in all four classes. A
class that never reaches an accepted batch is a class that never runs the savings
arithmetic or the conservation check behind it, which is why the breakdown is by
class and not only by outcome.

Reproduce with:

```
cd contracts && forge build
cd ../verifier && cargo run --release -p differential -- 1000000 1
```

## Raw output

```
mainnet corpus: 3000 legs from Dune query 8768375, dex.trades on chain 4663, August and September 2026

1000000 cases, seed 1, 8.3s
  adversarial  100000
  boundary     300000
  mainnet      200000
  random       400000
outcomes reached:
  adversarial ArithmeticOverflow             25176
  adversarial ArrayLengthMismatch            14731
  adversarial IntentIndexOutOfRange          8814
  adversarial LimitViolated                  187
  adversarial MalformedPackedExecutions      5839
  adversarial MalformedPackedIntents         6384
  adversarial NonUniformPrice                192
  adversarial OverfilledIntent               2396
  adversarial PartialFillNotAllowed          1166
  adversarial PriceOutsideBand               17963
  adversarial ReservedBytesNotZero           5145
  adversarial TokenIndexOutOfRange           7511
  adversarial ValueNotConserved              1367
  adversarial WorseThanBaseline              58
  adversarial accepted                       3071
  boundary    ArithmeticOverflow             104361
  boundary    IntentIndexOutOfRange          40679
  boundary    LimitViolated                  989
  boundary    NonUniformPrice                1301
  boundary    OverfilledIntent               13285
  boundary    PartialFillNotAllowed          6778
  boundary    PriceOutsideBand               73850
  boundary    TokenIndexOutOfRange           40260
  boundary    ValueNotConserved              5465
  boundary    WorseThanBaseline              380
  boundary    accepted                       12652
  mainnet     LimitViolated                  44009
  mainnet     NonUniformPrice                39394
  mainnet     PriceOutsideBand               20015
  mainnet     ValueNotConserved              8810
  mainnet     WorseThanBaseline              26709
  mainnet     accepted                       61063
  random      ArithmeticOverflow             360345
  random      IntentIndexOutOfRange          13326
  random      OverfilledIntent               4876
  random      PartialFillNotAllowed          2398
  random      PriceOutsideBand               5
  random      TokenIndexOutOfRange           13005
  random      ValueNotConserved              4277
  random      accepted                       1768

zero differences
```
