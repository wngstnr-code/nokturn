//! The revert surface, byte for byte.
//!
//! The differential gate in rencana-uji.md section 3 compares the kind of revert,
//! not only the returned value, so every variant here carries the same ABI encoding
//! its Solidity counterpart does. A variant that encoded differently would let the
//! two implementations disagree while the harness reported a match.

use alloy_primitives::{I256, U256};

extern crate alloc;
use alloc::vec::Vec;

/// Solidity's own panic, raised on checked arithmetic overflow. Every product in
/// the clearing path can reach it, which is why the core returns a Result rather
/// than wrapping.
pub const PANIC_SELECTOR: [u8; 4] = [0x4e, 0x48, 0x7b, 0x71];
pub const PANIC_ARITHMETIC: u64 = 0x11;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    MalformedPackedIntents(U256),
    MalformedPackedExecutions(U256),
    ArrayLengthMismatch,
    IntentIndexOutOfRange(U256),
    TokenIndexOutOfRange(u16),
    OverfilledIntent(U256, U256, U256),
    PartialFillNotAllowed(U256),
    LimitViolated(U256),
    NonUniformPrice(U256),
    ValueNotConserved(u16, I256),
    PriceOutsideBand(u16, U256, U256, u16),
    WorseThanBaseline(U256, U256, U256),
    ReservedBytesNotZero(U256),
    /// Panic(0x11), which Solidity raises rather than returning a custom error.
    ArithmeticOverflow,
}

/// The first four bytes of the keccak of each signature, written out rather than
/// hashed at runtime so the core stays free of a hash dependency. The differential
/// harness checks every one of them against the compiled Solidity ABI before it
/// starts, so a typo here fails the gate rather than hiding inside it.
impl VerifyError {
    pub fn selector(&self) -> [u8; 4] {
        match self {
            Self::MalformedPackedIntents(_) => [0xa4, 0xc5, 0xe9, 0x81],
            Self::MalformedPackedExecutions(_) => [0xf7, 0x87, 0x1f, 0x40],
            Self::ArrayLengthMismatch => [0xa2, 0x4a, 0x13, 0xa6],
            Self::IntentIndexOutOfRange(_) => [0x5e, 0x51, 0x91, 0xb0],
            Self::TokenIndexOutOfRange(_) => [0xd8, 0x1d, 0x7e, 0xd2],
            Self::OverfilledIntent(..) => [0xe3, 0x92, 0x7f, 0xfe],
            Self::PartialFillNotAllowed(_) => [0xed, 0x38, 0x59, 0x6f],
            Self::LimitViolated(_) => [0xbe, 0xe0, 0xcc, 0x30],
            Self::NonUniformPrice(_) => [0x6e, 0x76, 0x1d, 0x7d],
            Self::ValueNotConserved(..) => [0xb1, 0x0a, 0xc7, 0xb2],
            Self::PriceOutsideBand(..) => [0xd5, 0x58, 0xd8, 0x8a],
            Self::WorseThanBaseline(..) => [0xb0, 0xe3, 0x74, 0x89],
            Self::ReservedBytesNotZero(_) => [0x1c, 0xb5, 0xf4, 0x46],
            Self::ArithmeticOverflow => PANIC_SELECTOR,
        }
    }

    /// The full revert payload, selector followed by the arguments in ABI order.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + 128);
        out.extend_from_slice(&self.selector());
        match self {
            Self::ArrayLengthMismatch => {}
            Self::MalformedPackedIntents(a)
            | Self::MalformedPackedExecutions(a)
            | Self::IntentIndexOutOfRange(a)
            | Self::PartialFillNotAllowed(a)
            | Self::LimitViolated(a)
            | Self::NonUniformPrice(a)
            | Self::ReservedBytesNotZero(a) => push_word(&mut out, *a),
            Self::TokenIndexOutOfRange(t) => push_word(&mut out, U256::from(*t)),
            Self::OverfilledIntent(a, b, c) | Self::WorseThanBaseline(a, b, c) => {
                push_word(&mut out, *a);
                push_word(&mut out, *b);
                push_word(&mut out, *c);
            }
            Self::ValueNotConserved(t, delta) => {
                push_word(&mut out, U256::from(*t));
                out.extend_from_slice(&delta.to_be_bytes::<32>());
            }
            Self::PriceOutsideBand(t, price, reference, bps) => {
                push_word(&mut out, U256::from(*t));
                push_word(&mut out, *price);
                push_word(&mut out, *reference);
                push_word(&mut out, U256::from(*bps));
            }
            Self::ArithmeticOverflow => push_word(&mut out, U256::from(PANIC_ARITHMETIC)),
        }
        out
    }
}

fn push_word(out: &mut Vec<u8>, value: U256) {
    out.extend_from_slice(&value.to_be_bytes::<32>());
}

pub type VerifyResult<T> = Result<T, VerifyError>;
