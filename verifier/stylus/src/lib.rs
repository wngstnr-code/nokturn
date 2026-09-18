//! The Stylus surface over the clearing core.
//!
//! Everything this file does is decode arguments, call the core, and turn the
//! core's error back into the same revert the Solidity emits. The checks live in
//! clearing-core so that the code the differential gate compares is the code that
//! would be deployed, rather than a second copy of it that could drift.
//!
//! Nothing in the protocol depends on this landing. pitch.md puts the Stylus port
//! in v1.1 conditional on a benchmark, and the verifier address is immutable in
//! Settlement.sol, so moving to it means a new Settlement rather than an allowlist
//! change.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]

extern crate alloc;

use alloc::vec::Vec;

use stylus_sdk::alloy_primitives::{Address, Bytes, I256, U256};
use stylus_sdk::prelude::*;

use clearing_core::{evaluate_volume, verify, VerifyInput};

#[storage]
#[entrypoint]
pub struct ClearingVerifier;

#[public]
impl ClearingVerifier {
    #[allow(clippy::too_many_arguments)]
    pub fn verify(
        packed_intents: Bytes,
        packed_executions: Bytes,
        tokens: Vec<Address>,
        prices: Vec<U256>,
        venue_deltas: Vec<I256>,
        oracle_prices: Vec<U256>,
        baseline_quotes: Vec<U256>,
        max_deviation_bps: u16,
        max_fee_bps: u16,
    ) -> Result<U256, Vec<u8>> {
        let input = VerifyInput {
            packed_intents: &packed_intents,
            packed_executions: &packed_executions,
            token_count: tokens.len(),
            prices: &prices,
            venue_deltas: &venue_deltas,
            oracle_prices: &oracle_prices,
            baseline_quotes: &baseline_quotes,
            max_deviation_bps,
            max_fee_bps,
        };
        verify(&input).map_err(|e| e.encode())
    }

    pub fn evaluate_volume(
        packed_intents: Bytes,
        price: U256,
    ) -> Result<(U256, U256, U256), Vec<u8>> {
        evaluate_volume(&packed_intents, price).map_err(|e| e.encode())
    }
}
