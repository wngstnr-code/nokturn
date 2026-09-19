//! The mainnet slice of the input mix.
//!
//! rencana-uji.md section 3 asks for a fifth of the inputs to be real cases from
//! mainnet, and real means real. These are settled trade legs between the four
//! allowlist v1.0 stock tokens and USDG on chain 4663, pulled from Dune query
//! 8768375 with the raw amounts intact, so the six decimal side and the eighteen
//! decimal side arrive exactly as they did onchain.
//!
//! The harness refuses to run without this file rather than quietly filling the
//! slice with generated numbers. A gate that reports a mix it did not use is worse
//! than a gate that stops.

use std::path::Path;

use alloy_primitives::U256;

pub struct Leg {
    pub quote_is_sold: bool,
    pub sold_raw: U256,
    pub bought_raw: U256,
}

pub struct Corpus {
    pub legs: Vec<Leg>,
    pub source: String,
}

impl Corpus {
    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read the mainnet corpus at {}: {e}", path.display()))?;
        let json: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("corpus is not valid json: {e}"))?;
        let source = json["source"].as_str().unwrap_or("unknown").to_string();

        let mut legs = Vec::new();
        for item in json["legs"].as_array().ok_or("corpus has no legs array")? {
            let sold = item["sold"].as_str().ok_or("leg has no sold symbol")?;
            let sold_raw = parse(item["sold_raw"].as_str().ok_or("leg has no sold amount")?)?;
            let bought_raw = parse(item["bought_raw"].as_str().ok_or("leg has no bought amount")?)?;
            if sold_raw.is_zero() || bought_raw.is_zero() {
                continue;
            }
            legs.push(Leg { quote_is_sold: sold == "USDG", sold_raw, bought_raw });
        }
        if legs.is_empty() {
            return Err("corpus holds no usable legs".to_string());
        }
        Ok(Self { legs, source })
    }
}

fn parse(s: &str) -> Result<U256, String> {
    s.parse::<U256>().map_err(|e| format!("cannot read amount {s}: {e}"))
}
