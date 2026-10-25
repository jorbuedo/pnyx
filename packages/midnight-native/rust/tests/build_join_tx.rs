//! Native proven-unbound TRANSACTION assembly E2E: build a full `join` transaction
//! entirely in Rust — build the preimage, prove it at the TRANSACTION level (so each call's
//! `binding_input` is bound to the intent's Pedersen commitment), and serialize the result.
//!
//! Two oracles, both host-side (no chain):
//!  1. `build_join_proven_tx` returning Ok means `Transaction::prove` succeeded, which
//!     means the circuit proof self-verified against its verifier key inside
//!     `LocalProvingProvider` — a malformed transcript/proof would fail here.
//!  2. The bytes deserialize back as exactly `Transaction<Signature, ProofMarker, PedersenRandomness>`
//!     — the `('signature','proof','pre-binding')` marker triple `@midnight-ntwrk/ledger-v8`'s
//!     `Transaction.deserialize` (and thus `chain-client` `submitProven`) reconstructs.
//!
//! Live acceptance (the sponsor's `balanceTx` + node submit) is covered by `submit-proven-local`
//! against the standalone chain; that path is engine-independent of how the bytes were produced.
//!
//! Artifacts: same as `build_join_preimage` — the committed `join` fixtures,
//! the gitignored `contract/managed/{zkir,keys}` (SKIP if absent), and the KZG SRS cache.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use midnight_base_crypto::signatures::Signature;
use midnight_ledger::structure::{ProofMarker, Transaction};
use midnight_native::preimage::build_join_proven_tx;
use midnight_native::prove::circuit_k;
use midnight_serialize::tagged_deserialize;
use midnight_storage::DefaultDB;
use midnight_transient_crypto::commitment::PedersenRandomness;

type UnboundTx = Transaction<Signature, ProofMarker, PedersenRandomness, DefaultDB>;

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn srs_path(k: u8) -> Result<PathBuf, String> {
    let name = format!("bls_midnight_2p{k}");
    let dir = std::env::var("MIDNIGHT_PP")
        .map(PathBuf::from)
        .or_else(|_| {
            std::env::var("HOME")
                .map(|home| PathBuf::from(home).join(".cache/midnight/zk-params"))
                .map_err(|e| format!("$HOME not set: {e}"))
        })?;
    let path = dir.join(&name);
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("KZG params {name} not found in {}", dir.display()))
    }
}

fn inputs() -> ([u8; 32], [u8; 32], [u8; 32], [u8; 32]) {
    let json =
        fs::read_to_string(repo_path("fixtures/join.inputs.json")).expect("read join.inputs.json");
    let field = |key: &str| {
        let needle = format!("\"{key}\"");
        let start = json
            .find(&needle)
            .and_then(|i| json[i..].find(':').map(|j| i + j + 1))
            .expect("key");
        let rest = json[start..].trim_start();
        let quoted = rest.strip_prefix('"').expect("string value");
        quoted[..quoted.find('"').expect("closing quote")].to_string()
    };
    let bytes32 = |key: &str| -> [u8; 32] {
        hex::decode(field(key))
            .expect("hex")
            .try_into()
            .expect("32 bytes")
    };
    (
        bytes32("contractAddress"),
        bytes32("circleId"),
        bytes32("identitySk"),
        bytes32("personaSk"),
    )
}

#[test]
fn builds_and_proves_a_native_join_transaction() {
    let managed = repo_path("../../../contract/managed/circle");
    if !managed.exists() {
        eprintln!(
            "SKIP builds_and_proves_a_native_join_transaction: {} missing",
            managed.display()
        );
        return;
    }

    let (address, circle_id, identity_sk, persona_sk) = inputs();
    let contract_state =
        fs::read(repo_path("fixtures/join.contract_state")).expect("read contract-state fixture");
    let zkir = fs::read(managed.join("zkir/join.bzkir")).expect("read join.bzkir");
    let prover_key = fs::read(managed.join("keys/join.prover")).expect("read join.prover");
    let verifier_key = fs::read(managed.join("keys/join.verifier")).expect("read join.verifier");
    let k = circuit_k(&zkir).expect("read circuit k");
    let params = fs::read(srs_path(k).expect("locate KZG params")).expect("read KZG params");

    // Empty network id = the standalone `undeployed` network; ttl far in the future (unused off-chain).
    let start = Instant::now();
    let tx_bytes = build_join_proven_tx(
        &contract_state,
        address,
        circle_id,
        None,
        identity_sk,
        persona_sk,
        &zkir,
        &prover_key,
        &verifier_key,
        &params,
        "",
        4_102_444_800,
    )
    .expect("assemble + prove join transaction natively");
    let elapsed = start.elapsed();

    println!(
        "native join tx: K={k}, assembled+proved in {:.0} ms, {} bytes",
        elapsed.as_secs_f64() * 1000.0,
        tx_bytes.len(),
    );
    assert!(!tx_bytes.is_empty(), "tx bytes must not be empty");

    // Round-trip as exactly the (signature, proof, pre-binding) transaction ledger-v8 / submitProven expects.
    let tx: UnboundTx = tagged_deserialize(&mut &tx_bytes[..])
        .expect("proven-unbound tx must deserialize as Transaction<Signature, Proof, PreBinding>");
    match tx {
        Transaction::Standard(_) => {}
        Transaction::ClaimRewards(_) => panic!("expected a Standard transaction, got ClaimRewards"),
    }
}
