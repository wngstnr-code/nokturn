//! The clearing checks in Rust.
//!
//! This crate is the second implementation the differential gate in
//! rencana-uji.md section 3 compares against ClearingVerifier.sol. It holds no
//! state, performs no input or output, and knows nothing about Stylus, so the same
//! code answers the harness and the deployed program.

#![cfg_attr(not(feature = "std"), no_std)]

pub mod decode;
pub mod error;
pub mod math;
pub mod verify;

pub use error::{VerifyError, VerifyResult};
pub use verify::{evaluate_volume, verify, VerifyInput};
