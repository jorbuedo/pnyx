//! The two halves of the dApp connector's `ProvingProvider`, against a real circuit.
//!
//! A dApp hands us a preimage and its circuit's keys and asks us to check or prove it — so unlike the
//! per-circuit tests beside this one, what matters here is not *our* circuits but that the pair behaves
//! as `midnight-zkir`'s own `LocalProvingProvider` does: `check` needs the ZKIR alone, and `prove`
//! optionally replaces the preimage's binding input before proving.
//!
//! Artifacts are the committed `join` preimage plus `contract/managed/circle` (gitignored compile
//! output) and the KZG SRS from the `MidnightDataProvider` cache. The test SKIPS loudly when they are
//! absent: a missing compile artifact is not a regression.

use std::fs;
use std::path::PathBuf;

use midnight_native::prove::{check_preimage, circuit_k, prove_circuit, prove_circuit_binding};

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

/// The committed preimage and its circuit's artifacts, or `None` when the compile output is absent.
fn artifacts() -> Option<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>)> {
    let managed = repo_path("../../../contract/managed/circle");
    if !managed.exists() {
        eprintln!(
            "SKIP: {} is missing — run `bun run compile:contract`",
            managed.display()
        );
        return None;
    }
    let preimage =
        fs::read(repo_path("fixtures/join.preimage")).expect("read join.preimage fixture");
    let zkir = fs::read(managed.join("zkir/join.bzkir")).expect("read join.bzkir");
    let prover_key = fs::read(managed.join("keys/join.prover")).expect("read join.prover");
    let verifier_key = fs::read(managed.join("keys/join.verifier")).expect("read join.verifier");
    let k = circuit_k(&zkir).expect("read circuit k");
    let params = match srs_path(k) {
        Ok(path) => fs::read(path).expect("read KZG params"),
        Err(reason) => {
            eprintln!("SKIP: {reason}");
            return None;
        }
    };
    Some((zkir, prover_key, verifier_key, params, preimage))
}

#[test]
fn check_answers_from_the_zkir_alone() {
    let Some((zkir, _pk, _vk, _params, preimage)) = artifacts() else {
        return;
    };

    // The cheap half, and the point of it: no prover key, no verifier key, no SRS — a caller can check
    // a circuit it could not afford to prove.
    let skips = check_preimage(&zkir, &preimage).expect("check a well-formed preimage");

    println!(
        "check: {} pi-skip entries, {} of them set",
        skips.len(),
        skips.iter().filter(|s| s.is_some()).count()
    );
}

#[test]
fn check_refuses_a_preimage_that_is_not_one() {
    let Some((zkir, _pk, _vk, _params, _preimage)) = artifacts() else {
        return;
    };

    // Garbage in must be an error, not an empty answer: an empty skip vector is a *valid* result, so a
    // caller that received one for nonsense could not tell the difference.
    let error = check_preimage(&zkir, &[0u8; 8]).expect_err("nonsense is not a preimage");

    assert!(
        error.contains("preimage"),
        "the reason should name what failed, got: {error}"
    );
}

#[test]
fn check_refuses_a_zkir_that_is_not_one() {
    let Some((_zkir, _pk, _vk, _params, preimage)) = artifacts() else {
        return;
    };

    let error = check_preimage(&[0u8; 8], &preimage).expect_err("nonsense is not a circuit");

    assert!(
        error.contains("zkir"),
        "the reason should name what failed, got: {error}"
    );
}

#[test]
fn proving_without_an_override_is_the_old_path_exactly() {
    let Some((zkir, pk, vk, params, preimage)) = artifacts() else {
        return;
    };

    // `prove_circuit` delegates here with `None`, so this pins that the delegation changed nothing for
    // every existing caller. Both proofs verify internally (a returned proof is a verified proof), so
    // equal public inputs is the strong claim: the same statement was proved.
    let plain = prove_circuit(&zkir, &pk, &vk, &params, &preimage)
        .expect("prove without a binding override");
    let explicit_none = prove_circuit_binding(&zkir, &pk, &vk, &params, &preimage, None)
        .expect("prove with an explicit None");

    assert_eq!(plain.public_inputs, explicit_none.public_inputs);
}

#[test]
fn a_binding_override_proves_a_different_statement_and_still_verifies() {
    let Some((zkir, pk, vk, params, preimage)) = artifacts() else {
        return;
    };

    let plain = prove_circuit(&zkir, &pk, &vk, &params, &preimage).expect("prove as given");
    // A small canonical scalar: 1, little-endian.
    let mut binding = [0u8; 32];
    binding[0] = 1;

    let overridden = prove_circuit_binding(&zkir, &pk, &vk, &params, &preimage, Some(&binding))
        .expect("prove with the binding input replaced");

    // Success *is* verification — `prove_circuit_binding` verifies before returning — so reaching here
    // means the override produced a sound proof rather than one the verifier would reject. And the
    // statement moved, which is what a caller binding several proofs together is paying for.
    assert_ne!(plain.public_inputs, overridden.public_inputs);
}

#[test]
fn a_non_canonical_binding_input_is_refused_rather_than_reduced() {
    let Some((zkir, pk, vk, params, preimage)) = artifacts() else {
        return;
    };

    // All-ones is past the field modulus. Reducing it silently would prove a statement the caller did
    // not ask for, and the proof would verify — the worst shape of wrong.
    // `ProveOutput` is deliberately not `Debug` (a proof is not log material), so match rather than
    // `expect_err`.
    let error =
        match prove_circuit_binding(&zkir, &pk, &vk, &params, &preimage, Some(&[0xffu8; 32])) {
            Err(error) => error,
            Ok(_) => panic!("a non-canonical Fr is not a binding input"),
        };

    assert!(
        error.contains("canonical"),
        "the reason should say why, got: {error}"
    );
}
