//! Native proven-unbound TRANSACTION assembly for `claimFreePermit` — the tx-level sibling of
//! `build_payment_preimages`, and the shape the bridge actually hands the app.
//!
//! Two oracles, both host-side:
//!  1. `build_claim_free_permit_proven_tx` returning Ok means `Transaction::prove` succeeded, so the
//!     circuit proof self-verified against its verifier key inside `LocalProvingProvider`.
//!  2. The bytes deserialize back as exactly `Transaction<Signature, ProofMarker, PedersenRandomness>`
//!     — the `('signature','proof','pre-binding')` triple `chain-client`'s `submitProven` accepts.
//!
//! ⚠️ A tx-level proof is not optional here: `Transaction::prove` overwrites each call's
//! `binding_input` with the intent's Pedersen commitment, so the standalone proof
//! `build_payment_preimages` produces cannot be transplanted into a transaction.
//!
//! Artifacts: the committed `fixtures/payment_free_t6.contract_state` +
//! `fixtures/payment.inputs.json`, the gitignored `contract/managed/payment/{zkir,keys}` (SKIP when
//! absent), and the KZG SRS cache.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

/// An absolute expiry and a block time an hour before it.
///
/// ⚠️ Not a far-future sentinel. `well_formed` enforces a **global TTL ceiling** relative to the block
/// (`IntentTtlTooFarInFuture`), so the year-2100 value the other builders' tests use is itself
/// malformed — a fact only this test can see, because it is the only one that runs `well_formed`.
const TTL_SECS: u64 = 1_800_003_600;
const TBLOCK_SECS: u64 = 1_800_000_000;

use midnight_base_crypto::signatures::Signature;
use midnight_base_crypto::time::Timestamp;
use midnight_ledger::structure::{LedgerState, ProofMarker, Transaction};
use midnight_ledger::verify::WellFormedStrictness;
use midnight_native::preimage::build_claim_free_permit_proven_tx;
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

fn field(json: &str, key: &str) -> String {
    let needle = format!("\"{key}\"");
    let start = json
        .find(&needle)
        .and_then(|i| json[i..].find(':').map(|j| i + j + 1))
        .expect("key");
    let rest = json[start..].trim_start();
    match rest.strip_prefix('"') {
        Some(quoted) => quoted[..quoted.find('"').expect("closing quote")].to_string(),
        None => rest[..rest.find([',', '\n', '}']).expect("delimiter")]
            .trim()
            .to_string(),
    }
}

fn bytes32(json: &str, key: &str) -> [u8; 32] {
    hex::decode(field(json, key))
        .expect("hex")
        .try_into()
        .expect("32 bytes")
}

fn managed() -> Option<PathBuf> {
    let dir = repo_path("../../../contract/managed/payment");
    if dir.exists() {
        Some(dir)
    } else {
        eprintln!(
            "SKIP: {} is missing — run `bun run compile:contract`",
            dir.display()
        );
        None
    }
}

#[test]
fn claim_free_permit_assembles_and_proves_a_transaction() {
    let Some(managed) = managed() else { return };
    let json = fs::read_to_string(repo_path("fixtures/payment.inputs.json"))
        .expect("read payment.inputs.json");
    let state = fs::read(repo_path("fixtures/payment_free_t6.contract_state"))
        .expect("read the free-tier state");

    let zkir = fs::read(managed.join("zkir/claimFreePermit.bzkir")).expect("read bzkir");
    let prover_key =
        fs::read(managed.join("keys/claimFreePermit.prover")).expect("read prover key");
    let verifier_key =
        fs::read(managed.join("keys/claimFreePermit.verifier")).expect("read verifier key");
    let k = circuit_k(&zkir).expect("read circuit k");
    let params = fs::read(srs_path(k).expect("locate KZG params")).expect("read KZG params");

    let start = Instant::now();
    let tx_bytes = build_claim_free_permit_proven_tx(
        &state,
        bytes32(&json, "contractAddress"),
        6,
        bytes32(&json, "recipient"),
        &zkir,
        &prover_key,
        &verifier_key,
        &params,
        "undeployed",
        TTL_SECS,
    )
    .expect("assemble + prove claimFreePermit transaction natively");

    println!(
        "native claimFreePermit tx: K={k}, assembled+proved in {:.0} ms, {} bytes",
        start.elapsed().as_secs_f64() * 1000.0,
        tx_bytes.len(),
    );

    let tx: UnboundTx = tagged_deserialize(&mut &tx_bytes[..])
        .expect("proven-unbound tx must deserialize as Transaction<Signature, Proof, PreBinding>");
    match &tx {
        Transaction::Standard(_) => {}
        Transaction::ClaimRewards(_) => panic!("expected a Standard transaction, got ClaimRewards"),
    }

    // ⚠️ **The check that a proof cannot make.** `claimFreePermit` mints, and a mint's transcript claims
    // an unshielded spend to the recipient — which `well_formed` requires a matching real output for, in
    // the same intent and the same phase. A transaction with no `fallible_unshielded_offer` proves and
    // verifies perfectly and is then refused by the node as
    // `Custom error: 186 — Malformed::EffectsCheckFailure`. That cost one on-chain submission on
    // 2026-08-26 before this assertion existed.
    //
    // Everything else is turned off deliberately: the transaction is **pre-binding and unbalanced** (the
    // sponsor adds the fee), and the proofs need a verifier context this test does not build. What is
    // left is exactly the structural family the effects check belongs to.
    let mut strictness = WellFormedStrictness::default();
    strictness.enforce_balancing = false;
    strictness.verify_native_proofs = false;
    strictness.verify_contract_proofs = false;
    strictness.verify_signatures = false;
    strictness.enforce_limits = false;
    let state: LedgerState<DefaultDB> = LedgerState::new("undeployed");
    tx.well_formed(&state, strictness, Timestamp::from_secs(TBLOCK_SECS))
        .unwrap_or_else(|e| panic!("the assembled mint must be well-formed, got {e:?}"));
}

/// The tier gate reaches the caller before any artifact is read, so a bad tier costs nothing.
#[test]
fn a_tier_outside_the_range_is_refused_before_the_artifacts_are_touched() {
    let json = fs::read_to_string(repo_path("fixtures/payment.inputs.json"))
        .expect("read payment.inputs.json");
    let state = fs::read(repo_path("fixtures/payment_free_t6.contract_state"))
        .expect("read the free-tier state");
    let built = build_claim_free_permit_proven_tx(
        &state,
        bytes32(&json, "contractAddress"),
        7,
        bytes32(&json, "recipient"),
        &[],
        &[],
        &[],
        &[],
        "undeployed",
        4_102_444_800,
    );
    assert!(built.is_err(), "tier 7 must be refused");
}
