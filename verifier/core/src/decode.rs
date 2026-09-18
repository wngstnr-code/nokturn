//! The packed calldata layout, read the same way the Solidity reads it.
//!
//! Both records are a fixed stride, so an input whose length is not a multiple of
//! it is refused before anything is decoded. The reserved bytes are not padding
//! that happens to be ignored. They are checked to be zero, because a field that
//! is free to carry anything today is a field that changes meaning tomorrow.

use alloy_primitives::U256;

use crate::error::{VerifyError, VerifyResult};

pub const INTENT_STRIDE: usize = 72;
pub const EXECUTION_STRIDE: usize = 72;

pub const FLAG_PARTIAL_FILL: u8 = 1;

/// desain-kliring.md section 8 prices every token in USDG, so the numeraire sits
/// at index zero and the quote side of any pair is the USDG side.
pub const QUOTE_TOKEN_INDEX: u16 = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackedIntent {
    pub sell_token_index: u16,
    pub buy_token_index: u16,
    pub flags: u8,
    pub sell_amount: U256,
    pub min_buy_amount: U256,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackedExecution {
    pub intent_index: u32,
    pub executed_sell: U256,
    pub executed_buy: U256,
}

pub fn intent_at(packed: &[u8], index: usize) -> VerifyResult<PackedIntent> {
    let word = &packed[index * INTENT_STRIDE..(index + 1) * INTENT_STRIDE];
    if word[5] != 0 || word[6] != 0 || word[7] != 0 {
        return Err(VerifyError::ReservedBytesNotZero(U256::from(index)));
    }
    Ok(PackedIntent {
        sell_token_index: u16::from_be_bytes([word[0], word[1]]),
        buy_token_index: u16::from_be_bytes([word[2], word[3]]),
        flags: word[4],
        sell_amount: U256::from_be_slice(&word[8..40]),
        min_buy_amount: U256::from_be_slice(&word[40..72]),
    })
}

pub fn execution_at(packed: &[u8], index: usize) -> VerifyResult<PackedExecution> {
    let word = &packed[index * EXECUTION_STRIDE..(index + 1) * EXECUTION_STRIDE];
    if word[4..8] != [0, 0, 0, 0] {
        return Err(VerifyError::ReservedBytesNotZero(U256::from(index)));
    }
    Ok(PackedExecution {
        intent_index: u32::from_be_bytes([word[0], word[1], word[2], word[3]]),
        executed_sell: U256::from_be_slice(&word[8..40]),
        executed_buy: U256::from_be_slice(&word[40..72]),
    })
}
