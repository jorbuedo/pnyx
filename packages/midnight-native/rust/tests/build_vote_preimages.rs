//! Native preimage construction for `proposal.compact`'s two circuits: build each `ProofPreimage`
//! entirely in Rust, then prove + verify it host-side against the compiled artifacts. **A verifying
//! proof is the correctness oracle** — a transcript that drifts by one op will not prove.
//!
//! A proposal is its own contract (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10), and its electorate is a
//! snapshot: the member path is a fixture **input**, because the proposal holds no tree to look one up
//! in. That is also why this needs no whole-state Merkle deserialization — the ceiling that used to sit
//! in `member_merkle_path` is gone from this path.
//!
//! Artifacts:
//! - `fixtures/{cast_vote,reveal_vote}.contract_state` + `fixtures/vote.inputs.json` — regenerate with
//!   `node --import tsx packages/midnight-native/scripts/dump-vote-preimages.mts`. ⚠️ They derive from
//!   the gitignored `contract/managed`, so a contract recompile invalidates them.
//! - `contract/managed/proposal/{zkir,keys}` — gitignored compile output; the test SKIPS loudly when
//!   absent, since a missing compile artifact is not a regression.
//! - KZG SRS — the `MidnightDataProvider` cache (`$MIDNIGHT_PP` or `~/.cache/midnight/zk-params`).

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use midnight_native::preimage::{
    build_cast_vote_preimage, build_reveal_vote_preimage, member_path_from_bytes,
};
use midnight_native::prove::{circuit_k, prove_circuit, verify_proof};

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

fn json() -> String {
    fs::read_to_string(repo_path("fixtures/vote.inputs.json")).expect("read vote.inputs.json")
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
    let dir = repo_path("../../../contract/managed/proposal");
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

/// Prove one circuit and assert the proof verifies, then that a tampered statement does not.
fn prove_and_verify(managed: &PathBuf, circuit: &str, preimage: &[u8]) {
    let zkir = fs::read(managed.join(format!("zkir/{circuit}.bzkir"))).expect("read bzkir");
    let prover_key =
        fs::read(managed.join(format!("keys/{circuit}.prover"))).expect("read prover key");
    let verifier_key =
        fs::read(managed.join(format!("keys/{circuit}.verifier"))).expect("read verifier key");
    let k = circuit_k(&zkir).expect("read circuit k from zkir");
    let params = fs::read(srs_path(k).expect("locate KZG params")).expect("read KZG params");

    let start = Instant::now();
    let output = prove_circuit(&zkir, &prover_key, &verifier_key, &params, preimage)
        .unwrap_or_else(|e| panic!("prove natively-built {circuit} preimage: {e:?}"));
    println!(
        "native {circuit}: K={k}, built+proved+verified in {:.0} ms, proof {} bytes, {} public inputs",
        start.elapsed().as_secs_f64() * 1000.0,
        output.proof.len(),
        output.public_inputs.len(),
    );

    assert!(!output.proof.is_empty(), "proof must not be empty");
    assert!(
        !output.public_inputs.is_empty(),
        "statement must not be empty"
    );
    verify_proof(&verifier_key, &params, &output.proof, &output.public_inputs)
        .expect("verify serialized proof against serialized statement");

    // A tampered statement must not verify — otherwise the check above proves nothing.
    let mut tampered = output.public_inputs.clone();
    tampered[0][0] ^= 1;
    assert!(
        verify_proof(&verifier_key, &params, &output.proof, &tampered).is_err(),
        "a tampered statement must not verify"
    );
}

#[test]
fn builds_proves_and_verifies_native_cast_vote_preimage() {
    let Some(managed) = managed() else { return };
    let json = json();
    let path = member_path_from_bytes(&hex::decode(field(&json, "memberPath")).expect("hex"))
        .expect("decode the member path");
    let option: u8 = field(&json, "ballotOption")
        .parse()
        .expect("ballotOption is a number");

    let contract_state =
        fs::read(repo_path("fixtures/cast_vote.contract_state")).expect("read state fixture");
    let preimage = build_cast_vote_preimage(
        &contract_state,
        bytes32(&json, "castVoteAddress"),
        bytes32(&json, "personaSk"),
        option,
        bytes32(&json, "ballotRand"),
        &path,
    )
    .expect("build castVote preimage natively");

    prove_and_verify(&managed, "castVote", &preimage);
}

#[test]
fn builds_proves_and_verifies_native_reveal_vote_preimage() {
    let Some(managed) = managed() else { return };
    let json = json();
    let option: u8 = field(&json, "ballotOption")
        .parse()
        .expect("ballotOption is a number");

    // The state *after* castVote, so the ballot is already committed — `revealVote` opens it.
    let contract_state =
        fs::read(repo_path("fixtures/reveal_vote.contract_state")).expect("read state fixture");
    let preimage = build_reveal_vote_preimage(
        &contract_state,
        bytes32(&json, "revealVoteAddress"),
        bytes32(&json, "personaSk"),
        option,
        bytes32(&json, "ballotRand"),
    )
    .expect("build revealVote preimage natively");

    prove_and_verify(&managed, "revealVote", &preimage);
}

/// The member path crosses the bridge as 20 x (32-byte sibling, 1 byte goes_left). A wrong length or a
/// `goes_left` that is neither 0 nor 1 must be refused by name rather than silently truncated.
#[test]
fn a_malformed_member_path_is_refused_by_name() {
    assert!(member_path_from_bytes(&[0u8; 32])
        .unwrap_err()
        .contains("20 x 33"));
    let mut bad = vec![0u8; 20 * 33];
    bad[32] = 2;
    assert!(member_path_from_bytes(&bad)
        .unwrap_err()
        .contains("goes_left"));
}
