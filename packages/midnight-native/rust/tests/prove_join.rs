//! Host-side proving E2E: prove `join` from the pnyx contract with the committed
//! fixture preimage, verify against the compiled verifier key, and reject a tampered statement.
//!
//! Artifacts:
//! - `fixtures/join.preimage` — committed; regenerate with
//!   `node --import tsx packages/midnight-native/scripts/dump-join-preimage.mts`
//!   (personaSk = 0x0b×32, circleId = 1, fresh simulated ledger).
//! - `contract/managed/circle/{zkir,keys}` — gitignored compile output; regenerate with
//!   `bun run compile:contract`. The test SKIPS (with a loud message) when absent, since a
//!   missing compile artifact is not a proving regression.
//! - KZG SRS — the `MidnightDataProvider` cache (`$MIDNIGHT_PP` or
//!   `~/.cache/midnight/zk-params/bls_midnight_2p<K>`), populated by any prior proof-server or
//!   harness run; fetchable from the Midnight S3 fileshare.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

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

/// Peak resident set size of this test process, from /proc/self/status (Linux).
fn peak_rss_mib() -> Option<f64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    let kib: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib / 1024.0)
}

#[test]
fn proves_and_verifies_join() {
    let managed = repo_path("../../../contract/managed/circle");
    if !managed.exists() {
        eprintln!(
            "SKIP proves_and_verifies_join: {} is missing — run `bun run compile:contract`",
            managed.display()
        );
        return;
    }

    let zkir = fs::read(managed.join("zkir/join.bzkir")).expect("read join.bzkir");
    let prover_key = fs::read(managed.join("keys/join.prover")).expect("read join.prover");
    let verifier_key = fs::read(managed.join("keys/join.verifier")).expect("read join.verifier");
    let preimage =
        fs::read(repo_path("fixtures/join.preimage")).expect("read committed preimage fixture");

    let k = circuit_k(&zkir).expect("read circuit k from zkir");
    let params = fs::read(srs_path(k).expect("locate KZG params")).expect("read KZG params");

    let start = Instant::now();
    let output =
        prove_circuit(&zkir, &prover_key, &verifier_key, &params, &preimage).expect("prove join");
    let prove_time = start.elapsed();

    println!(
        "join: K={k}, proved+verified in {:.0} ms, proof {} bytes, {} public inputs, peak RSS {} MiB",
        prove_time.as_secs_f64() * 1000.0,
        output.proof.len(),
        output.public_inputs.len(),
        peak_rss_mib().map_or("?".into(), |mib| format!("{mib:.0}")),
    );

    assert!(!output.proof.is_empty(), "proof must not be empty");
    assert!(
        !output.public_inputs.is_empty(),
        "statement must not be empty"
    );

    // Standalone verification round-trip (prove_circuit already self-verifies; this pins
    // the serialized forms).
    verify_proof(&verifier_key, &params, &output.proof, &output.public_inputs)
        .expect("verify serialized proof against serialized statement");

    // Tampering with the statement must fail verification — proves the check is real.
    let mut tampered = output.public_inputs.clone();
    tampered[0][0] ^= 1;
    assert!(
        verify_proof(&verifier_key, &params, &output.proof, &tampered).is_err(),
        "tampered statement must not verify"
    );
}
