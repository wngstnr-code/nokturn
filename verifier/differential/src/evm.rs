//! One deployed copy of ClearingVerifier.sol, called in process.
//!
//! A million inputs is out of reach over RPC, so the Solidity side runs inside
//! revm against the artifact forge already produced. The contract is pure and takes
//! no constructor arguments, so the runtime code is installed directly and no
//! deployment transaction is needed.

use std::collections::HashMap;
use std::path::Path;

use alloy_primitives::{keccak256, Address, Bytes, TxKind, U256};
use revm::context::result::{ExecutionResult, Output};
use revm::context::TxEnv;
use revm::database::{CacheDB, EmptyDB};
use revm::state::{AccountInfo, Bytecode};
use revm::{Context, ExecuteEvm, MainBuilder, MainContext};

pub const VERIFIER: Address = Address::new([0x11; 20]);
pub const CALLER: Address = Address::new([0x22; 20]);

/// What one call came back with. A revert carries its raw payload, because the
/// gate compares the revert itself and not merely the fact of one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Returned(Bytes),
    Reverted(Bytes),
    Halted(String),
}

pub struct Solidity {
    evm: revm::MainnetEvm<revm::Context<revm::context::BlockEnv, TxEnv, revm::context::CfgEnv, CacheDB<EmptyDB>>>,
}

impl Solidity {
    pub fn load(artifact: &Path) -> Result<(Self, HashMap<String, [u8; 4]>), String> {
        let raw = std::fs::read_to_string(artifact)
            .map_err(|e| format!("cannot read {}: {e}", artifact.display()))?;
        let json: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("cannot parse artifact: {e}"))?;

        let code = json["deployedBytecode"]["object"]
            .as_str()
            .ok_or("artifact has no deployed bytecode")?;
        let code = Bytes::from(
            hex_decode(code.trim_start_matches("0x")).ok_or("deployed bytecode is not hex")?,
        );

        let mut db = CacheDB::new(EmptyDB::default());
        db.insert_account_info(
            VERIFIER,
            AccountInfo {
                balance: U256::ZERO,
                nonce: 1,
                code_hash: keccak256(&code),
                code: Some(Bytecode::new_raw(code)),
                ..Default::default()
            },
        );
        db.insert_account_info(CALLER, AccountInfo::default());

        let evm = Context::mainnet().with_db(db).build_mainnet();
        Ok((Self { evm }, selectors(&json)))
    }

    pub fn call(&mut self, data: Vec<u8>) -> Outcome {
        let tx = TxEnv {
            caller: CALLER,
            kind: TxKind::Call(VERIFIER),
            data: Bytes::from(data),
            gas_limit: 16_000_000,
            gas_price: 0,
            ..Default::default()
        };
        match self.evm.transact(tx) {
            Ok(state) => match state.result {
                ExecutionResult::Success { output, .. } => match output {
                    Output::Call(b) => Outcome::Returned(b),
                    Output::Create(b, _) => Outcome::Returned(b),
                },
                ExecutionResult::Revert { output, .. } => Outcome::Reverted(output),
                ExecutionResult::Halt { reason, .. } => Outcome::Halted(format!("{reason:?}")),
            },
            Err(e) => Outcome::Halted(format!("{e:?}")),
        }
    }
}

/// Every custom error the compiled contract declares, with the selector taken from
/// its own ABI. The rust core writes its selectors out by hand, and this is what
/// proves each of those bytes is the byte the contract will actually emit.
fn selectors(json: &serde_json::Value) -> HashMap<String, [u8; 4]> {
    let mut out = HashMap::new();
    let Some(items) = json["abi"].as_array() else { return out };
    for item in items {
        if item["type"].as_str() != Some("error") {
            continue;
        }
        let Some(name) = item["name"].as_str() else { continue };
        let args: Vec<&str> = item["inputs"]
            .as_array()
            .map(|a| a.iter().filter_map(|i| i["type"].as_str()).collect())
            .unwrap_or_default();
        let signature = format!("{name}({})", args.join(","));
        let hash = keccak256(signature.as_bytes());
        out.insert(name.to_string(), [hash[0], hash[1], hash[2], hash[3]]);
    }
    out
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}
