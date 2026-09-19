//! ClearingMath.sol, predicate for predicate.
//!
//! Solidity 0.8 checks every product, so a multiplication that would wrap reverts
//! with Panic(0x11) instead of returning a wrong answer. Wrapping here would make
//! the two implementations disagree on exactly the inputs a differential test
//! exists to find, so every product goes through checked_mul and every overflow
//! becomes the same panic.

use alloy_primitives::U256;

use crate::error::{VerifyError, VerifyResult};

pub const BPS: u64 = 10_000;
pub const WAD: u64 = 1_000_000_000_000_000_000;

pub fn mul(a: U256, b: U256) -> VerifyResult<U256> {
    a.checked_mul(b).ok_or(VerifyError::ArithmeticOverflow)
}

pub fn add(a: U256, b: U256) -> VerifyResult<U256> {
    a.checked_add(b).ok_or(VerifyError::ArithmeticOverflow)
}

/// b * S >= B * s. The realised rate beats the asked rate, with no division on
/// either side.
pub fn limit_respected(
    executed_buy: U256,
    sell_amount: U256,
    min_buy_amount: U256,
    executed_sell: U256,
) -> VerifyResult<bool> {
    Ok(mul(executed_buy, sell_amount)? >= mul(min_buy_amount, executed_sell)?)
}

/// Whether the value withheld from one fill is inside the fee ceiling. The early
/// return on valueOut above valueIn happens before any product, so an input that
/// would overflow the second line never reaches it.
pub fn fee_within_band(value_in: U256, value_out: U256, max_fee_bps: u16) -> VerifyResult<bool> {
    if value_out > value_in {
        return Ok(false);
    }
    let withheld = mul(value_in - value_out, U256::from(BPS))?;
    Ok(withheld <= mul(value_in, U256::from(max_fee_bps))?)
}

/// Whether a clearing price sits inside the band around the oracle reference.
/// Symmetric because the distance is taken before the comparison.
pub fn within_band(price: U256, reference: U256, max_deviation_bps: u16) -> VerifyResult<bool> {
    let diff = if price > reference { price - reference } else { reference - price };
    Ok(mul(diff, U256::from(BPS))? <= mul(reference, U256::from(max_deviation_bps))?)
}
