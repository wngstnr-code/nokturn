//! Input generation, in the mix rencana-uji.md section 3 asks for.
//!
//! The generator is a plain xorshift seeded from the command line, so a failing
//! run is reproduced by repeating its seed rather than by saving a corpus of
//! everything that passed.
//!
//! Shapes are drawn to land on the checks rather than in front of them. A purely
//! random byte string fails the stride test every time and teaches nothing about
//! the arithmetic behind it, so lengths are built from whole records and the
//! interesting values are drawn from a pool that is mostly boundaries.

use alloy_primitives::{I256, U256};

use clearing_core::decode::{EXECUTION_STRIDE, FLAG_PARTIAL_FILL, INTENT_STRIDE};

use crate::corpus::Corpus;

#[derive(Debug, Clone)]
pub struct Case {
    pub packed_intents: Vec<u8>,
    pub packed_executions: Vec<u8>,
    pub tokens: Vec<[u8; 20]>,
    pub prices: Vec<U256>,
    pub venue_deltas: Vec<I256>,
    pub oracle_prices: Vec<U256>,
    pub baseline_quotes: Vec<U256>,
    pub max_deviation_bps: u16,
    pub max_fee_bps: u16,
    pub class: Class,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Random,
    Boundary,
    Mainnet,
    Adversarial,
}

impl Class {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Random => "random",
            Self::Boundary => "boundary",
            Self::Mainnet => "mainnet",
            Self::Adversarial => "adversarial",
        }
    }
}

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed | 1)
    }

    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }

    pub fn word(&mut self) -> U256 {
        U256::from_limbs([self.next(), self.next(), self.next(), self.next()])
    }
}

/// The values a clearing bug actually hides behind. Zero and one because they are
/// the identities, the maximum because that is where a checked product stops being
/// a product, and the wad scale because every price in this protocol is quoted
/// against it.
const WAD: u128 = 1_000_000_000_000_000_000;

fn pool(rng: &mut Rng, class: Class) -> U256 {
    let max = U256::MAX;
    match class {
        Class::Random => rng.word(),
        _ => match rng.below(12) {
            0 => U256::ZERO,
            1 => U256::from(1u64),
            2 => max,
            3 => max - U256::from(1u64),
            4 => U256::from(WAD),
            5 => U256::from(WAD) - U256::from(1u64),
            6 => U256::from(WAD) + U256::from(1u64),
            7 => U256::from(10_000u64),
            8 => max / U256::from(WAD),
            9 => max / U256::from(10_000u64),
            10 => U256::from(rng.next()),
            _ => U256::from(200u64) * U256::from(WAD),
        },
    }
}

fn word_bytes(value: U256) -> [u8; 32] {
    value.to_be_bytes::<32>()
}

pub fn generate(rng: &mut Rng, class: Class, corpus: &Corpus) -> Case {
    if class == Class::Mainnet {
        return from_mainnet(rng, corpus);
    }

    let token_count = 1 + rng.below(4) as usize;
    let intent_count = rng.below(7) as usize;
    let execution_count = rng.below(7) as usize;

    let mut packed_intents = Vec::with_capacity(intent_count * INTENT_STRIDE);
    for _ in 0..intent_count {
        let sell_token = rng.below(token_count as u64 + 1) as u16;
        let buy_token = rng.below(token_count as u64 + 1) as u16;
        packed_intents.extend_from_slice(&sell_token.to_be_bytes());
        packed_intents.extend_from_slice(&buy_token.to_be_bytes());
        packed_intents.push(rng.below(4) as u8);
        // The reserved bytes are usually zero, because a case that trips the
        // reserved check learns nothing about the arithmetic behind it.
        let reserved = if class == Class::Adversarial && rng.below(8) == 0 {
            [rng.next() as u8, rng.next() as u8, rng.next() as u8]
        } else {
            [0, 0, 0]
        };
        packed_intents.extend_from_slice(&reserved);
        packed_intents.extend_from_slice(&word_bytes(pool(rng, class)));
        packed_intents.extend_from_slice(&word_bytes(pool(rng, class)));
    }

    let mut packed_executions = Vec::with_capacity(execution_count * EXECUTION_STRIDE);
    for _ in 0..execution_count {
        let index = if intent_count == 0 {
            rng.below(3) as u32
        } else {
            rng.below(intent_count as u64 + 1) as u32
        };
        packed_executions.extend_from_slice(&index.to_be_bytes());
        let reserved = if class == Class::Adversarial && rng.below(8) == 0 {
            (rng.next() as u32).to_be_bytes()
        } else {
            [0u8; 4]
        };
        packed_executions.extend_from_slice(&reserved);
        packed_executions.extend_from_slice(&word_bytes(pool(rng, class)));
        packed_executions.extend_from_slice(&word_bytes(pool(rng, class)));
    }

    // Length mismatches are worth reaching, but only now and then, because every
    // one of them stops at the first check.
    if class == Class::Adversarial && rng.below(16) == 0 {
        packed_intents.push(0);
    }
    if class == Class::Adversarial && rng.below(16) == 0 {
        packed_executions.push(0);
    }

    let tokens = (0..token_count)
        .map(|k| {
            let mut a = [0u8; 20];
            a[19] = k as u8 + 1;
            a
        })
        .collect();

    let prices: Vec<U256> = (0..token_count).map(|_| pool(rng, class)).collect();
    let oracle_prices: Vec<U256> = (0..token_count)
        .map(|k| {
            // Most of the time the oracle sits near the clearing price, so the band
            // check passes and the loop behind it is reached at all.
            if rng.below(4) == 0 {
                pool(rng, class)
            } else {
                prices[k]
            }
        })
        .collect();
    let venue_deltas: Vec<I256> =
        (0..token_count).map(|_| I256::from_raw(pool(rng, class))).collect();
    let mut baseline_quotes: Vec<U256> =
        (0..execution_count).map(|_| pool(rng, class)).collect();

    // Array lengths that disagree are unreachable any other way, because every
    // other path builds them from the same count.
    let mut prices = prices;
    let mut oracle_prices: Vec<U256> = oracle_prices;
    let mut venue_deltas: Vec<I256> = venue_deltas;
    if class == Class::Adversarial {
        match rng.below(24) {
            0 => {
                prices.push(U256::ZERO);
            }
            1 => {
                oracle_prices.pop();
            }
            2 => {
                venue_deltas.push(I256::ZERO);
            }
            3 => {
                baseline_quotes.push(U256::ZERO);
            }
            _ => {}
        }
    }

    Case {
        packed_intents,
        packed_executions,
        tokens,
        prices,
        venue_deltas,
        oracle_prices,
        baseline_quotes,
        max_deviation_bps: [0u16, 1, 20, 30, 60, 100, 150, 200, 10_000, u16::MAX]
            [rng.below(10) as usize],
        max_fee_bps: [0u16, 1, 3, 20, 10_000, u16::MAX][rng.below(6) as usize],
        class,
    }
}

/// A batch built from trade legs that really settled. Two tokens, USDG at the
/// numeraire index the packed layout reserves for it and the stock token beside
/// it, with the price taken from the rate the leg actually cleared at.
///
/// The price convention is parameter.md section 4C, which is USD with eighteen
/// decimals per smallest unit, scaled by another eighteen. USDG is a dollar across
/// six decimals, so it sits at 1e30, and the stock price falls out of the leg.
fn from_mainnet(rng: &mut Rng, corpus: &Corpus) -> Case {
    let quote_price = U256::from(10u64).pow(U256::from(30u64));
    let scale = U256::from(10u64).pow(U256::from(30u64));

    let anchor = &corpus.legs[rng.below(corpus.legs.len() as u64) as usize];
    // Every intent in one batch clears at one price, which is what makes the batch
    // a batch. The anchor leg sets it and the rest are measured against it.
    let stock_price = if anchor.quote_is_sold {
        anchor.sold_raw * scale / anchor.bought_raw
    } else {
        anchor.bought_raw * scale / anchor.sold_raw
    };

    let count = 1 + rng.below(5) as usize;
    let mut packed_intents = Vec::with_capacity(count * INTENT_STRIDE);
    let mut packed_executions = Vec::with_capacity(count * EXECUTION_STRIDE);
    let mut baseline_quotes = Vec::with_capacity(count);
    let mut pulled = [U256::ZERO; 2];
    let mut delivered = [U256::ZERO; 2];

    for k in 0..count {
        let leg = &corpus.legs[rng.below(corpus.legs.len() as u64) as usize];
        let (sell_index, buy_index, sell_amount) = if leg.quote_is_sold {
            (0u16, 1u16, leg.sold_raw)
        } else {
            (1u16, 0u16, leg.sold_raw)
        };
        // What the uniform price owes this seller at the batch price, floored the
        // way the contract floors it.
        let owed = if leg.quote_is_sold {
            sell_amount * scale / stock_price
        } else {
            sell_amount * stock_price / scale
        };

        let partial = rng.below(2) == 0;
        let executed_sell = if partial && sell_amount > U256::from(1u64) {
            sell_amount - U256::from(rng.below(1000) + 1)
        } else {
            sell_amount
        };
        let executed_buy = if leg.quote_is_sold {
            executed_sell * scale / stock_price
        } else {
            executed_sell * stock_price / scale
        };

        let flags = if executed_sell != sell_amount { FLAG_PARTIAL_FILL } else { rng.below(2) as u8 };
        packed_intents.extend_from_slice(&sell_index.to_be_bytes());
        packed_intents.extend_from_slice(&buy_index.to_be_bytes());
        packed_intents.push(flags);
        packed_intents.extend_from_slice(&[0, 0, 0]);
        packed_intents.extend_from_slice(&word_bytes(sell_amount));
        // The asked rate sits at or just under what the batch price delivers, so
        // the limit check is reached rather than tripped on every leg.
        // A real intent asks for slightly less than the batch rate delivers,
        // because it was written before the batch existed. Now and then it asks
        // for more, which is the case that has to be refused.
        let asked = if rng.below(8) == 0 {
            owed + owed / U256::from(100u64) + U256::from(1u64)
        } else {
            owed - owed / U256::from(100u64)
        };
        packed_intents.extend_from_slice(&word_bytes(asked));

        packed_executions.extend_from_slice(&(k as u32).to_be_bytes());
        packed_executions.extend_from_slice(&[0, 0, 0, 0]);
        packed_executions.extend_from_slice(&word_bytes(executed_sell));
        packed_executions.extend_from_slice(&word_bytes(executed_buy));

        pulled[sell_index as usize] += executed_sell;
        delivered[buy_index as usize] += executed_buy;

        // The baseline is the venue quote the batch has to beat. Now and again it
        // is set above what was delivered, which is the case that must be refused.
        baseline_quotes.push(if rng.below(10) == 0 {
            executed_buy + U256::from(1u64)
        } else {
            executed_buy - executed_buy / U256::from(1000u64)
        });
    }

    // A batch nets what it can and routes the rest through a venue, so the deltas
    // are the shortfall the venue leg has to cover. One case in eight is a shilling
    // short, which is the shape a solver would use to keep the difference.
    let short = rng.below(8) == 0;
    let venue_deltas: Vec<I256> = (0..2)
        .map(|t| {
            let owed = delivered[t].saturating_sub(pulled[t]);
            let covered = if short { owed.saturating_sub(U256::from(1u64)) } else { owed };
            I256::from_raw(covered)
        })
        .collect();

    let prices = vec![quote_price, stock_price];
    let oracle_prices = if rng.below(5) == 0 {
        vec![quote_price, stock_price + stock_price / U256::from(100u64)]
    } else {
        prices.clone()
    };

    Case {
        packed_intents,
        packed_executions,
        tokens: vec![[0u8; 20], {
            let mut a = [0u8; 20];
            a[19] = 1;
            a
        }],
        prices,
        venue_deltas: venue_deltas,
        oracle_prices,
        baseline_quotes,
        max_deviation_bps: [20u16, 30, 60, 100, 150, 200][rng.below(6) as usize],
        max_fee_bps: [0u16, 1, 3, 20][rng.below(4) as usize],
        class: Class::Mainnet,
    }
}
