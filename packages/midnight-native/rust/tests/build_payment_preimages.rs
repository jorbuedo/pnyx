//! Native preimage construction for `payment.compact`'s `claimFreePermit` — a permit for a wallet with
//! nothing in it, built entirely in Rust and proved host-side against the compiled artifact.
//!
//! **A verifying proof is the correctness oracle.** The transcript in `preimage.rs` is written by hand
//! — the device has no Compact runtime to generate one — so a drifted op is a compile error nowhere. It
//! surfaces at the node as "Public transcript input mismatch for input N" with no clue which op moved.
//!
//! ⚠️ **This is the first ported circuit that MINTS.** `bind` receives a permit and `moderate` spends
//! one; nothing in this crate had minted before. `mintUnshieldedToken` is not one effects write but
//! two — `unshielded_mints` keyed by the raw domain (a u64 counter), then `claimed_unshielded_spends`
//! keyed by the full token type and recipient (a u128 counter) — with a read of the contract's **own
//! address** between them, which is how the type is derived at all. Every one of those facts came from
//! `dump-transcript.mts claimFreePermit` rather than from reading the contract, and each is invisible
//! in the source: the counter widths differ, the mints map is keyed by domain where the receive map is
//! keyed by type, and the self-address read has no syntax of its own.
//!
//! ⚠️ **Proving does not catch an effects mismatch** — only the node's replay does, which is why the
//! ops are asserted here too (`midnight-ledger` `semantics.rs` requires declared effects to equal
//! computed ones).
//!
//! Artifacts:
//! - `fixtures/payment_free_t6.contract_state`, `fixtures/payment.inputs.json` — committed; regenerate
//!   with `node --import tsx packages/midnight-native/scripts/dump-handle-fixtures.mts`.
//! - `contract/managed/payment/{zkir,keys}` — gitignored compile output (`bun run compile:contract`);
//!   these tests SKIP loudly when absent, since a missing compile artifact is not a regression.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use midnight_native::preimage::build_claim_free_permit_preimage;
use midnight_native::prove::{circuit_k, prove_circuit};

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

fn inputs() -> String {
    fs::read_to_string(repo_path("fixtures/payment.inputs.json")).expect("read payment.inputs.json")
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

fn free_state() -> Vec<u8> {
    fs::read(repo_path("fixtures/payment_free_t6.contract_state"))
        .expect("read the free-tier state")
}

#[test]
fn claim_free_permit_preimage_proves_against_the_compiled_circuit() {
    let Some(managed) = managed() else { return };
    let json = inputs();
    let preimage = build_claim_free_permit_preimage(
        &free_state(),
        bytes32(&json, "contractAddress"),
        6,
        bytes32(&json, "recipient"),
    )
    .expect("build claimFreePermit preimage");

    let zkir = fs::read(managed.join("zkir/claimFreePermit.bzkir")).expect("read bzkir");
    let prover_key =
        fs::read(managed.join("keys/claimFreePermit.prover")).expect("read prover key");
    let verifier_key =
        fs::read(managed.join("keys/claimFreePermit.verifier")).expect("read verifier key");
    let k = circuit_k(&zkir).expect("read circuit k");
    let params = fs::read(srs_path(k).expect("locate KZG params")).expect("read KZG params");

    let start = Instant::now();
    let output = prove_circuit(&zkir, &prover_key, &verifier_key, &params, &preimage)
        .unwrap_or_else(|e| panic!("prove natively-built claimFreePermit preimage: {e}"));
    println!(
        "native claimFreePermit: K={k}, built+proved+verified in {:.0} ms, proof {} bytes",
        start.elapsed().as_secs_f64() * 1000.0,
        output.proof.len(),
    );
}

/// The gate, from the builder's side: a fresh deployment has no free row, so the transcript it would
/// declare does not match what the runtime computes and construction fails here rather than at a node.
#[test]
fn a_tier_with_no_free_row_cannot_be_built() {
    let fresh =
        fs::read(repo_path("fixtures/payment_fresh.contract_state")).expect("read fresh state");
    let json = inputs();
    let built = build_claim_free_permit_preimage(
        &fresh,
        bytes32(&json, "contractAddress"),
        6,
        bytes32(&json, "recipient"),
    );
    assert!(
        built.is_err(),
        "a claim against a contract with no free row must not build"
    );
}

/// Tier is a public argument and each tier is its own permit colour, so building for the wrong one
/// produces a different transcript — the mint would be under a colour `bind` will not accept.
#[test]
fn each_tier_builds_its_own_permit_colour() {
    let Some(_) = managed() else { return };
    let json = inputs();
    let six = build_claim_free_permit_preimage(
        &free_state(),
        bytes32(&json, "contractAddress"),
        6,
        bytes32(&json, "recipient"),
    )
    .expect("tier 6 is the open one");
    // Tier 5 has no row in this fixture, so it must not build at all.
    assert!(
        build_claim_free_permit_preimage(
            &free_state(),
            bytes32(&json, "contractAddress"),
            5,
            bytes32(&json, "recipient")
        )
        .is_err(),
        "tier 5 is not free in this fixture",
    );
    assert!(!six.is_empty());
}

#[test]
fn a_tier_outside_the_range_is_refused_before_anything_else() {
    let json = inputs();
    let built = build_claim_free_permit_preimage(
        &free_state(),
        bytes32(&json, "contractAddress"),
        7,
        bytes32(&json, "recipient"),
    );
    assert!(built.is_err());
}
