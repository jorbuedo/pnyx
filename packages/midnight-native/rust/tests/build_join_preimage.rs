//! Native preimage construction E2E: build the `join` `ProofPreimage` entirely in
//! Rust (no committed-preimage read), then prove + verify it host-side with the compiled
//! artifacts. A verifying proof is the correctness oracle — a malformed preimage will not prove.
//!
//! Artifacts:
//! - `fixtures/join.contract_state` + `.inputs.json` — committed; regenerate with
//!   `node --import tsx packages/midnight-native/scripts/dump-join-preimage.mts` (identitySk =
//!   0x07×32, personaSk = 0x0b×32, circleId = 0x01×32, fresh simulated ledger; the address is
//!   recorded in the JSON). ⚠️ They derive from the gitignored `contract/managed`, so a contract
//!   recompile invalidates them — regenerate before debugging a failure here.
//! - `contract/managed/circle/{zkir,keys}` — gitignored compile output (`bun run compile:contract`);
//!   the test SKIPS (loudly) when absent, since a missing compile artifact is not a regression.
//! - KZG SRS — the `MidnightDataProvider` cache (`$MIDNIGHT_PP` or
//!   `~/.cache/midnight/zk-params/bls_midnight_2p<K>`).

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use midnight_native::preimage::build_join_preimage;
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
        Err(format!(
            "KZG params {name} not found in {} — run any proof-server prove once, or fetch it from the \
             Midnight S3 fileshare (see MidnightDataProvider in midnight-base-crypto)",
            dir.display()
        ))
    }
}

/// The fixed circleId (0x01×32), identitySk (0x07×32) and personaSk (0x0b×32) the dump script uses.
/// `circleId` is a `Bytes<32>` constructor argument now, not a `Field` circuit argument.
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

/// The gated fixture's inputs, which carry the invite secret the open one has no use for.
fn gated_inputs() -> ([u8; 32], [u8; 32], [u8; 32], [u8; 32], [u8; 32]) {
    let json = fs::read_to_string(repo_path("fixtures/join_gated.inputs.json")).expect("read gated inputs");
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
        hex::decode(field(key)).expect("hex").try_into().expect("32 bytes")
    };
    (
        bytes32("contractAddress"),
        bytes32("circleId"),
        bytes32("identitySk"),
        bytes32("personaSk"),
        bytes32("inviteSecret"),
    )
}

#[test]
fn builds_proves_and_verifies_native_join_preimage() {
    let managed = repo_path("../../../contract/managed/circle");
    if !managed.exists() {
        eprintln!(
            "SKIP builds_proves_and_verifies_native_join_preimage: {} is missing — run \
             `bun run compile:contract`",
            managed.display()
        );
        return;
    }

    let (address, circle_id, identity_sk, persona_sk) = inputs();
    let contract_state = fs::read(repo_path("fixtures/join.contract_state"))
        .expect("read committed contract-state fixture");

    // Construct the preimage entirely in Rust.
    let preimage = build_join_preimage(&contract_state, address, circle_id, None, identity_sk, persona_sk)
        .expect("build join preimage natively");

    let zkir = fs::read(managed.join("zkir/join.bzkir")).expect("read join.bzkir");
    let prover_key = fs::read(managed.join("keys/join.prover")).expect("read join.prover");
    let verifier_key = fs::read(managed.join("keys/join.verifier")).expect("read join.verifier");

    let k = circuit_k(&zkir).expect("read circuit k from zkir");
    let params = fs::read(srs_path(k).expect("locate KZG params")).expect("read KZG params");

    let start = Instant::now();
    let output = prove_circuit(&zkir, &prover_key, &verifier_key, &params, &preimage)
        .expect("prove natively-built join preimage");
    let prove_time = start.elapsed();

    println!(
        "native join: K={k}, built+proved+verified in {:.0} ms, proof {} bytes, {} public inputs",
        prove_time.as_secs_f64() * 1000.0,
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

    let mut tampered = output.public_inputs.clone();
    tampered[0][0] ^= 1;
    assert!(
        verify_proof(&verifier_key, &params, &output.proof, &tampered).is_err(),
        "tampered statement must not verify"
    );
}

/// The **gated** arm of `join` — the one the device rail could not build until now.
///
/// `join` is one circuit with two transcripts: `assert(open || invites.member(c))` short-circuits on
/// an open circle and never touches the invite registry, while a gated one reads it and then removes
/// the commitment it spends. Nine ops separate the two programs, and a proof is the only thing that
/// says whether they are in the right places — a transcript that mirrors the wrong arm does not
/// prove.
///
/// Regenerate its fixtures with `dump-join-preimage.mts gated`.
#[test]
fn builds_proves_and_verifies_a_gated_join_preimage() {
    let managed = repo_path("../../../contract/managed/circle");
    if !managed.exists() {
        eprintln!(
            "SKIP builds_proves_and_verifies_a_gated_join_preimage: {} is missing — run \
             `bun run compile:contract`",
            managed.display()
        );
        return;
    }

    let (address, circle_id, identity_sk, persona_sk, invite_secret) = gated_inputs();
    let contract_state = fs::read(repo_path("fixtures/join_gated.contract_state"))
        .expect("read committed gated contract-state fixture");

    let preimage = build_join_preimage(
        &contract_state,
        address,
        circle_id,
        Some(invite_secret),
        identity_sk,
        persona_sk,
    )
    .expect("build gated join preimage natively");

    let zkir = fs::read(managed.join("zkir/join.bzkir")).expect("read join.bzkir");
    let prover_key = fs::read(managed.join("keys/join.prover")).expect("read join.prover");
    let verifier_key = fs::read(managed.join("keys/join.verifier")).expect("read join.verifier");
    let k = circuit_k(&zkir).expect("read circuit k from zkir");
    let params = fs::read(srs_path(k).expect("locate KZG params")).expect("read KZG params");

    let output = prove_circuit(&zkir, &prover_key, &verifier_key, &params, &preimage)
        .expect("prove natively-built gated join preimage");
    verify_proof(&verifier_key, &params, &output.proof, &output.public_inputs)
        .expect("verify the gated join proof");

    // ⚠️ The arm is not a hint the builder may get wrong quietly. Building the *open* transcript
    // against a gated circle's state must be refused outright — the `isOpen` popeq alone disagrees —
    // rather than producing a preimage that fails much later at proving with no clue why.
    let wrong_arm = build_join_preimage(&contract_state, address, circle_id, None, identity_sk, persona_sk);
    assert!(
        wrong_arm.is_err(),
        "the open arm must be refused against a gated circle's state, got a preimage"
    );
}
