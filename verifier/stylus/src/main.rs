//! Prints the Solidity interface this program exposes, so it can be diffed against
//! IClearingVerifier.sol rather than assumed to match it.

#[cfg(feature = "export-abi")]
fn main() {
    clearing_verifier_stylus::print_from_args();
}

#[cfg(not(feature = "export-abi"))]
fn main() {}
