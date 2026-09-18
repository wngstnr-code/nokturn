//! The differential gate of rencana-uji.md section 3.
//!
//! Two implementations, written in two languages with two arithmetic models, are
//! handed the same input and have to agree on the answer and on the revert. A
//! disagreement is printed with the seed that produced it, because a gate that
//! cannot be reproduced is a gate nobody fixes.

mod cases;
mod corpus;
mod evm;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use alloy_primitives::U256;
use alloy_sol_types::{sol, SolCall};

use cases::{Case, Class, Rng};
use clearing_core::{evaluate_volume, verify, VerifyError, VerifyInput};
use evm::{Outcome, Solidity};

sol! {
    function verify(
        bytes packedIntents,
        bytes packedExecutions,
        address[] tokens,
        uint256[] prices,
        int256[] venueDeltas,
        uint256[] oraclePrices,
        uint256[] baselineQuotes,
        uint16 maxDeviationBps,
        uint16 maxFeeBps
    ) external pure returns (uint256 savings);

    function evaluateVolume(bytes packedIntents, uint256 price)
        external
        pure
        returns (uint256 demand, uint256 supply, uint256 executable);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let total: u64 = args.next().and_then(|v| v.parse().ok()).unwrap_or(10_000);
    let seed: u64 = args.next().and_then(|v| v.parse().ok()).unwrap_or(1);

    let artifact = PathBuf::from("../contracts/out/ClearingVerifier.sol/ClearingVerifier.json");
    let (mut solidity, abi_selectors) = match Solidity::load(&artifact) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("differential: {e}");
            eprintln!("run forge build in contracts first");
            std::process::exit(1);
        }
    };

    if let Err(e) = check_selectors(&abi_selectors) {
        eprintln!("differential: {e}");
        std::process::exit(1);
    }

    let corpus_path = PathBuf::from("differential/corpus/mainnet-legs.json");
    let corpus = match corpus::Corpus::load(&corpus_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("differential: {e}");
            std::process::exit(1);
        }
    };
    println!("mainnet corpus: {} legs from {}", corpus.legs.len(), corpus.source);

    let mut rng = Rng::new(seed);
    let mut counts: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut reverts: BTreeMap<String, u64> = BTreeMap::new();
    let mut differences = 0u64;
    let started = Instant::now();

    for n in 0..total {
        let class = class_for(n, total);
        let case = cases::generate(&mut rng, class, &corpus);
        *counts.entry(class.name()).or_default() += 1;

        if let Some(report) = compare_verify(&mut solidity, &case, &mut reverts) {
            differences += 1;
            println!("DIFFERENCE seed {seed} case {n} verify\n{report}");
            if differences >= 10 {
                break;
            }
        }
        if let Some(report) = compare_volume(&mut solidity, &case, &mut rng) {
            differences += 1;
            println!("DIFFERENCE seed {seed} case {n} evaluateVolume\n{report}");
            if differences >= 10 {
                break;
            }
        }
    }

    let elapsed = started.elapsed();
    println!("\n{total} cases, seed {seed}, {:.1}s", elapsed.as_secs_f64());
    for (name, count) in &counts {
        println!("  {name:12} {count}");
    }
    println!("outcomes reached:");
    for (name, count) in &reverts {
        println!("  {name:42} {count}");
    }
    if differences == 0 {
        println!("\nzero differences");
    } else {
        println!("\n{differences} differences");
        std::process::exit(1);
    }
}

/// Forty percent random, thirty boundary, twenty from mainnet, ten adversarial.
fn class_for(n: u64, total: u64) -> Class {
    let position = (n * 10) / total.max(1);
    match position {
        0..=3 => Class::Random,
        4..=6 => Class::Boundary,
        7..=8 => Class::Mainnet,
        _ => Class::Adversarial,
    }
}

/// The rust core writes its selectors out by hand. This is what proves each of
/// those bytes is the byte the compiled contract will emit.
fn check_selectors(abi: &std::collections::HashMap<String, [u8; 4]>) -> Result<(), String> {
    let expected: Vec<(&str, VerifyError)> = vec![
        ("MalformedPackedIntents", VerifyError::MalformedPackedIntents(U256::ZERO)),
        ("MalformedPackedExecutions", VerifyError::MalformedPackedExecutions(U256::ZERO)),
        ("ArrayLengthMismatch", VerifyError::ArrayLengthMismatch),
        ("IntentIndexOutOfRange", VerifyError::IntentIndexOutOfRange(U256::ZERO)),
        ("TokenIndexOutOfRange", VerifyError::TokenIndexOutOfRange(0)),
        ("OverfilledIntent", VerifyError::OverfilledIntent(U256::ZERO, U256::ZERO, U256::ZERO)),
        ("PartialFillNotAllowed", VerifyError::PartialFillNotAllowed(U256::ZERO)),
        ("LimitViolated", VerifyError::LimitViolated(U256::ZERO)),
        ("NonUniformPrice", VerifyError::NonUniformPrice(U256::ZERO)),
        ("ValueNotConserved", VerifyError::ValueNotConserved(0, alloy_primitives::I256::ZERO)),
        ("PriceOutsideBand", VerifyError::PriceOutsideBand(0, U256::ZERO, U256::ZERO, 0)),
        ("WorseThanBaseline", VerifyError::WorseThanBaseline(U256::ZERO, U256::ZERO, U256::ZERO)),
        ("ReservedBytesNotZero", VerifyError::ReservedBytesNotZero(U256::ZERO)),
    ];
    if abi.len() != expected.len() {
        return Err(format!(
            "the contract declares {} errors and the core knows {}",
            abi.len(),
            expected.len()
        ));
    }
    for (name, variant) in expected {
        let from_abi = abi.get(name).ok_or(format!("contract has no error {name}"))?;
        if *from_abi != variant.selector() {
            return Err(format!(
                "selector for {name} is {:02x?} in the contract and {:02x?} in the core",
                from_abi,
                variant.selector()
            ));
        }
    }
    Ok(())
}

fn compare_verify(
    solidity: &mut Solidity,
    case: &Case,
    reverts: &mut BTreeMap<String, u64>,
) -> Option<String> {
    let call = verifyCall {
        packedIntents: case.packed_intents.clone().into(),
        packedExecutions: case.packed_executions.clone().into(),
        tokens: case.tokens.iter().map(|a| (*a).into()).collect(),
        prices: case.prices.clone(),
        venueDeltas: case.venue_deltas.clone(),
        oraclePrices: case.oracle_prices.clone(),
        baselineQuotes: case.baseline_quotes.clone(),
        maxDeviationBps: case.max_deviation_bps,
        maxFeeBps: case.max_fee_bps,
    };
    let outcome = solidity.call(call.abi_encode());

    let input = VerifyInput {
        packed_intents: &case.packed_intents,
        packed_executions: &case.packed_executions,
        token_count: case.tokens.len(),
        prices: &case.prices,
        venue_deltas: &case.venue_deltas,
        oracle_prices: &case.oracle_prices,
        baseline_quotes: &case.baseline_quotes,
        max_deviation_bps: case.max_deviation_bps,
        max_fee_bps: case.max_fee_bps,
    };
    let rust = verify(&input);

    *reverts.entry(format!("{:<11} {}", case.class.name(), label(&rust))).or_default() += 1;
    agree(&outcome, rust.map(|v| v.to_be_bytes::<32>().to_vec()), case)
}

fn compare_volume(solidity: &mut Solidity, case: &Case, rng: &mut Rng) -> Option<String> {
    let price = if rng.below(3) == 0 { U256::ZERO } else { rng.word() };
    let call = evaluateVolumeCall {
        packedIntents: case.packed_intents.clone().into(),
        price,
    };
    let outcome = solidity.call(call.abi_encode());

    let rust = evaluate_volume(&case.packed_intents, price).map(|(d, s, e)| {
        let mut out = Vec::with_capacity(96);
        out.extend_from_slice(&d.to_be_bytes::<32>());
        out.extend_from_slice(&s.to_be_bytes::<32>());
        out.extend_from_slice(&e.to_be_bytes::<32>());
        out
    });
    agree(&outcome, rust, case)
}

fn agree(
    outcome: &Outcome,
    rust: Result<Vec<u8>, VerifyError>,
    case: &Case,
) -> Option<String> {
    match (outcome, rust) {
        (Outcome::Returned(got), Ok(want)) if got.as_ref() == want.as_slice() => None,
        (Outcome::Reverted(got), Err(want)) if got.as_ref() == want.encode().as_slice() => None,
        (Outcome::Returned(got), Ok(want)) => {
            Some(describe(case, &format!("solidity returned {got:x}"), &format!("rust returned 0x{}", hex(&want))))
        }
        (Outcome::Returned(got), Err(want)) => {
            Some(describe(case, &format!("solidity returned {got:x}"), &format!("rust reverted {want:?}")))
        }
        (Outcome::Reverted(got), Ok(want)) => {
            Some(describe(case, &format!("solidity reverted {got:x}"), &format!("rust returned 0x{}", hex(&want))))
        }
        (Outcome::Reverted(got), Err(want)) => Some(describe(
            case,
            &format!("solidity reverted {got:x}"),
            &format!("rust reverted {want:?} as 0x{}", hex(&want.encode())),
        )),
        (Outcome::Halted(why), rust) => {
            Some(describe(case, &format!("solidity halted {why}"), &format!("rust {rust:?}")))
        }
    }
}

fn describe(case: &Case, left: &str, right: &str) -> String {
    format!(
        "  class {}\n  {left}\n  {right}\n  intents 0x{}\n  executions 0x{}\n  prices {:?}\n  oracle {:?}\n  deltas {:?}\n  baselines {:?}\n  maxDeviationBps {} maxFeeBps {}",
        case.class.name(),
        hex(&case.packed_intents),
        hex(&case.packed_executions),
        case.prices,
        case.oracle_prices,
        case.venue_deltas,
        case.baseline_quotes,
        case.max_deviation_bps,
        case.max_fee_bps
    )
}

fn label(result: &Result<U256, VerifyError>) -> String {
    match result {
        Ok(_) => "accepted".to_string(),
        Err(e) => format!("{e:?}").split('(').next().unwrap_or("error").to_string(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
