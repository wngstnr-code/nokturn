//! ClearingVerifier.sol in Rust, in the same order.
//!
//! The order is part of the specification, not an implementation detail. Two
//! implementations that raise the same set of errors on different inputs still
//! disagree, so every check sits where the Solidity puts it and the first failure
//! wins in both.

use alloy_primitives::{I256, U256};

extern crate alloc;
use alloc::vec;
use alloc::vec::Vec;

use crate::decode::{
    execution_at, intent_at, EXECUTION_STRIDE, FLAG_PARTIAL_FILL, INTENT_STRIDE, QUOTE_TOKEN_INDEX,
};
use crate::error::{VerifyError, VerifyResult};
use crate::math::{add, fee_within_band, limit_respected, mul, within_band, WAD};

pub struct VerifyInput<'a> {
    pub packed_intents: &'a [u8],
    pub packed_executions: &'a [u8],
    pub token_count: usize,
    pub prices: &'a [U256],
    pub venue_deltas: &'a [I256],
    pub oracle_prices: &'a [U256],
    pub baseline_quotes: &'a [U256],
    pub max_deviation_bps: u16,
    pub max_fee_bps: u16,
}

pub fn verify(input: &VerifyInput<'_>) -> VerifyResult<U256> {
    if input.packed_intents.len() % INTENT_STRIDE != 0 {
        return Err(VerifyError::MalformedPackedIntents(U256::from(input.packed_intents.len())));
    }
    if input.packed_executions.len() % EXECUTION_STRIDE != 0 {
        return Err(VerifyError::MalformedPackedExecutions(U256::from(
            input.packed_executions.len(),
        )));
    }
    if input.token_count != input.prices.len() || input.token_count != input.venue_deltas.len() {
        return Err(VerifyError::ArrayLengthMismatch);
    }
    if input.token_count != input.oracle_prices.len() {
        return Err(VerifyError::ArrayLengthMismatch);
    }

    let intent_count = input.packed_intents.len() / INTENT_STRIDE;
    let execution_count = input.packed_executions.len() / EXECUTION_STRIDE;
    if input.baseline_quotes.len() != execution_count {
        return Err(VerifyError::ArrayLengthMismatch);
    }

    check_band(input.prices, input.oracle_prices, input.max_deviation_bps)?;

    let mut pulled: Vec<U256> = vec![U256::ZERO; input.token_count];
    let mut delivered: Vec<U256> = vec![U256::ZERO; input.token_count];
    let mut savings = U256::ZERO;

    for k in 0..execution_count {
        let e = execution_at(input.packed_executions, k)?;
        if e.intent_index as usize >= intent_count {
            return Err(VerifyError::IntentIndexOutOfRange(U256::from(e.intent_index)));
        }

        let i = intent_at(input.packed_intents, e.intent_index as usize)?;
        if i.sell_token_index as usize >= input.token_count {
            return Err(VerifyError::TokenIndexOutOfRange(i.sell_token_index));
        }
        if i.buy_token_index as usize >= input.token_count {
            return Err(VerifyError::TokenIndexOutOfRange(i.buy_token_index));
        }

        if e.executed_sell > i.sell_amount {
            return Err(VerifyError::OverfilledIntent(
                U256::from(e.intent_index),
                e.executed_sell,
                i.sell_amount,
            ));
        }
        if e.executed_sell != i.sell_amount && i.flags & FLAG_PARTIAL_FILL == 0 {
            return Err(VerifyError::PartialFillNotAllowed(U256::from(e.intent_index)));
        }

        if !limit_respected(e.executed_buy, i.sell_amount, i.min_buy_amount, e.executed_sell)? {
            return Err(VerifyError::LimitViolated(U256::from(e.intent_index)));
        }

        check_uniform_price(
            &e,
            input.prices[i.sell_token_index as usize],
            input.prices[i.buy_token_index as usize],
            input.max_fee_bps,
        )?;

        if e.executed_buy < input.baseline_quotes[k] {
            return Err(VerifyError::WorseThanBaseline(
                U256::from(e.intent_index),
                e.executed_buy,
                input.baseline_quotes[k],
            ));
        }

        let sell_slot = i.sell_token_index as usize;
        let buy_slot = i.buy_token_index as usize;
        pulled[sell_slot] = add(pulled[sell_slot], e.executed_sell)?;
        delivered[buy_slot] = add(delivered[buy_slot], e.executed_buy)?;

        let gained = e.executed_buy - input.baseline_quotes[k];
        let priced = mul(gained, input.prices[buy_slot])? / U256::from(WAD);
        savings = add(savings, priced)?;
    }

    check_conservation(&pulled, &delivered, input.venue_deltas)?;
    Ok(savings)
}

pub fn evaluate_volume(packed_intents: &[u8], price: U256) -> VerifyResult<(U256, U256, U256)> {
    if packed_intents.len() % INTENT_STRIDE != 0 {
        return Err(VerifyError::MalformedPackedIntents(U256::from(packed_intents.len())));
    }
    let count = packed_intents.len() / INTENT_STRIDE;

    let mut demand = U256::ZERO;
    let mut supply = U256::ZERO;
    let wad = U256::from(WAD);

    for n in 0..count {
        let i = intent_at(packed_intents, n)?;
        // Buyers spend the quote token and want the base token. Their limit price
        // is sellAmount over minBuyAmount, so they accept p when sellAmount is at
        // least minBuyAmount times p, written without a division.
        if i.sell_token_index == QUOTE_TOKEN_INDEX {
            if mul(i.sell_amount, wad)? >= mul(i.min_buy_amount, price)? {
                demand = add(demand, i.min_buy_amount)?;
            }
        } else if mul(i.min_buy_amount, wad)? <= mul(i.sell_amount, price)? {
            supply = add(supply, i.sell_amount)?;
        }
    }

    let executable = if demand < supply { demand } else { supply };
    Ok((demand, supply, executable))
}

fn check_uniform_price(
    e: &crate::decode::PackedExecution,
    sell_price: U256,
    buy_price: U256,
    max_fee_bps: u16,
) -> VerifyResult<()> {
    let value_in = mul(e.executed_sell, sell_price)?;
    let value_out = mul(e.executed_buy, buy_price)?;
    if !fee_within_band(value_in, value_out, max_fee_bps)? {
        return Err(VerifyError::NonUniformPrice(U256::from(e.intent_index)));
    }
    Ok(())
}

fn check_band(prices: &[U256], oracle_prices: &[U256], max_deviation_bps: u16) -> VerifyResult<()> {
    // The token index fits a u16 because the packed intent addresses it with two
    // bytes, so a longer token array could not be referenced at all.
    for t in 0..prices.len() {
        if !within_band(prices[t], oracle_prices[t], max_deviation_bps)? {
            return Err(VerifyError::PriceOutsideBand(
                t as u16,
                prices[t],
                oracle_prices[t],
                max_deviation_bps,
            ));
        }
    }
    Ok(())
}

/// Solidity's uint256 to int256 conversion wraps rather than reverting, and the
/// addition after it is what reverts. Both halves are reproduced, because a
/// balance built from wrapped operands is a value the Solidity can reach.
fn check_conservation(
    pulled: &[U256],
    delivered: &[U256],
    venue_deltas: &[I256],
) -> VerifyResult<()> {
    for t in 0..pulled.len() {
        let pulled_signed = I256::from_raw(pulled[t]);
        let delivered_signed = I256::from_raw(delivered[t]);
        let balance = pulled_signed
            .checked_add(venue_deltas[t])
            .and_then(|v| v.checked_sub(delivered_signed))
            .ok_or(VerifyError::ArithmeticOverflow)?;
        if balance.is_negative() {
            return Err(VerifyError::ValueNotConserved(t as u16, balance));
        }
    }
    Ok(())
}
