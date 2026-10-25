//! Native preimage construction for `circle.compact`'s `leaveCircle` — the self-authorised removal.
//!
//! Built in Rust, then proved + verified host-side against the compiled artifacts. **A verifying
//! proof is the correctness oracle**: a transcript that drifts by one op does not prove, and the
//! node's own error would name neither op nor cause.
//!
//! ⚠️ **Fallible, like `addModerator` and unlike the invite circuits.** The transcript slot is not
//! visible in the source and a misplaced one fails at submission with no mention of it, so this was
//! read off `dump-transcript.mts leaveCircle` rather than derived — see `build_prototype`, which
//! puts every prototype in the fallible slot for exactly this reason.
//!
//! ⚠️ **Removal is not the inverse of `join`.** `join` inserts into `joinedIdentities` and nothing
//! removes from it, so a leaver can never rejoin. That is deliberate — it is the same set that makes
//! a ban permanent — and it is asserted here so the property cannot be lost by accident.
//!
//! Fixture: `fixtures/circle_populated.contract_state`, whose founder `personaCommitment(bytes32(11))`
//! has joined and is therefore a member. Regenerate with
//! `node --import tsx packages/midnight-native/scripts/dump-vote-preimages.mts`.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use midnight_native::circle::member_path;
use midnight_native::deploy::CIRCLE_ENTRY_POINTS;
use midnight_native::preimage::{build_leave_circle_preimage, member_path_from_bytes};
use midnight_native::prove::{circuit_k, prove_circuit, verify_proof};

/// The fixture's founder persona — computed the way the contract does rather than pasted, so a
/// derivation change fails here instead of drifting quietly.
fn founder_persona_sk() -> [u8; 32] {
    [11u8; 32]
}

const CONTRACT_ADDRESS: [u8; 32] = [0xba; 32];

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

struct Artifacts {
    zkir: Vec<u8>,
    prover: Vec<u8>,
    verifier: Vec<u8>,
    params: Vec<u8>,
    k: u8,
}

fn artifacts(circuit: &str) -> Option<Artifacts> {
    let managed = repo_path("../../../contract/managed/circle");
    let zkir = fs::read(managed.join(format!("zkir/{circuit}.bzkir"))).ok()?;
    let prover = fs::read(managed.join(format!("keys/{circuit}.prover"))).ok()?;
    let verifier = fs::read(managed.join(format!("keys/{circuit}.verifier"))).ok()?;
    let k = circuit_k(&zkir).expect("read circuit k");
    let params = fs::read(srs_path(k).ok()?).ok()?;
    Some(Artifacts {
        zkir,
        prover,
        verifier,
        params,
        k,
    })
}

fn state() -> Vec<u8> {
    fs::read(repo_path("fixtures/circle_populated.contract_state"))
        .expect("read circle_populated.contract_state")
}

/// `persona_commitment(sk)` as the contract computes it — `persistentHash(["pnyx:pc", sk])`.
/// Spelled out here rather than imported, so the crate's derivation is checked against a second
/// statement of the rule instead of against itself.
fn persona_commitment(sk: [u8; 32]) -> [u8; 32] {
    let mut tag = [0u8; 32];
    tag[.."pnyx:pc".len()].copy_from_slice(b"pnyx:pc");
    let mut input = Vec::with_capacity(64);
    input.extend_from_slice(&tag);
    input.extend_from_slice(&sk);
    midnight_base_crypto::hash::persistent_hash(&input).0
}

fn prove_and_verify(circuit: &str, preimage: &[u8]) {
    let Some(a) = artifacts(circuit) else {
        eprintln!(
            "SKIP {circuit}: contract/managed/circle or the KZG params are absent — compile first"
        );
        return;
    };
    let started = Instant::now();
    let output = prove_circuit(&a.zkir, &a.prover, &a.verifier, &a.params, preimage).unwrap_or_else(|e| {
        panic!("{circuit}: the transcript did not prove — it has drifted from the compiled circuit: {e:?}")
    });
    let elapsed = started.elapsed();
    verify_proof(&a.verifier, &a.params, &output.proof, &output.public_inputs).unwrap_or_else(
        |e| panic!("{circuit}: the proof did not verify against its own verifier key: {e:?}"),
    );

    // ⚠️ Without this the verify above proves nothing: a check that accepts anything would still pass.
    let mut tampered = output.public_inputs.clone();
    tampered[0][0] ^= 1;
    assert!(
        verify_proof(&a.verifier, &a.params, &output.proof, &tampered).is_err(),
        "{circuit}: a tampered statement must not verify"
    );

    eprintln!(
        "{circuit}: K={} proved+verified in {} ms, proof {} bytes",
        a.k,
        elapsed.as_millis(),
        output.proof.len()
    );
}

#[test]
fn leave_circle_proves() {
    let state_bytes = state();
    let sk = founder_persona_sk();
    let path =
        member_path(&state_bytes, persona_commitment(sk)).expect("the founder joined this circle");
    let entries = member_path_from_bytes(&path).expect("decode the member path");
    let preimage = build_leave_circle_preimage(&state_bytes, CONTRACT_ADDRESS, sk, &entries)
        .expect("build the leaveCircle preimage");
    prove_and_verify("leaveCircle", &preimage);
}

/// A second seated member whose secret we know — `dump-vote-preimages.mts` puts it at a **non-zero**
/// leaf index on purpose.
fn leaver_persona_sk() -> [u8; 32] {
    [0x51; 32]
}

#[test]
fn leave_circle_proves_from_a_non_zero_leaf_index() {
    // ⚠️ **The founder alone proves nothing about the index derivation.** It sits at index 0, where
    // every bit is zero and the twenty-deep fold reads the same forwards or backwards — reversing the
    // bit order still produced a verifying proof. This member is not at zero, so the order is load-
    // bearing here: get it wrong and the transcript blanks a different leaf and fails to prove.
    let state_bytes = state();
    let sk = leaver_persona_sk();
    let path = member_path(&state_bytes, persona_commitment(sk))
        .expect("the second member is seated in this circle");
    let entries = member_path_from_bytes(&path).expect("decode the member path");
    assert!(
        entries.iter().any(|(_, goes_left)| !*goes_left),
        "this member must not be at index 0, or the test cannot see the bit order"
    );
    let preimage = build_leave_circle_preimage(&state_bytes, CONTRACT_ADDRESS, sk, &entries)
        .expect("build the leaveCircle preimage");
    prove_and_verify("leaveCircle", &preimage);
}

#[test]
fn a_non_member_cannot_build_a_leave() {
    let state_bytes = state();
    // A persona that never joined has no leaf, so the path read fails before a transcript exists —
    // the refusal a stranger gets is a missing path, not an unsatisfiable constraint several layers
    // down. Same shape as the invite-authority gate reading its cell in the builder.
    assert!(
        member_path(&state_bytes, persona_commitment([0x5e; 32])).is_err(),
        "a persona that never joined must not resolve a member path"
    );
}

#[test]
fn leave_circle_is_a_declared_entry_point() {
    // The entry-point list feeds the deploy address, so a name missing here is a different contract
    // rather than a tolerable difference — and a proof would never catch it.
    assert!(
        CIRCLE_ENTRY_POINTS.contains(&"leaveCircle"),
        "leaveCircle must be a declared circle entry point"
    );
}
