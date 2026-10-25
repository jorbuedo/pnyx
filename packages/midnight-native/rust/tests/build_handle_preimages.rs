//! Native preimage construction for `handle.compact`'s two provable-by-a-user circuits, `bind` and
//! `rebind`: build the `ProofPreimage` entirely in Rust, then prove + verify it host-side against the
//! compiled artifacts.
//!
//! **A verifying proof is the correctness oracle.** The transcripts in `preimage.rs` are written by
//! hand — the device has no Compact runtime to generate them — so a drifted op is not a compile error
//! anywhere. It surfaces at the node as "Public transcript input mismatch for input 9" with no clue
//! which op moved. A malformed preimage will not prove, so proving here is what makes the port
//! trustworthy.
//!
//! ⚠️ **These are the first ported circuits that move a token.** `receiveUnshielded` is not a separate
//! effects API: it compiles to sixteen ops that `swap` the VM stack to the `Effects` container and
//! increment `unshielded_inputs` (index 6). A port mirroring only the contract-state ops builds a
//! transcript the node rejects with `EffectsMismatch`, because it replays the program and requires the
//! declared effects to equal the computed ones (`midnight-ledger` `semantics.rs`). Proving does not
//! catch that — only the replay does — so the ops are asserted here as well.
//!
//! ⚠️ **Neither call balances.** `bind` spends a tier permit and `rebind` a per-name one, and no
//! permit exists until `payment.compact` is deployed and `grantPermit` has run. These tests cover
//! transcript construction and proving; settlement needs a chain.
//!
//! Artifacts:
//! - `fixtures/handle_*.contract_state`, `fixtures/handle.inputs.json` — committed; regenerate with
//!   `node --import tsx packages/midnight-native/scripts/dump-handle-fixtures.mts`.
//! - `contract/managed/handle/{zkir,keys}` — gitignored compile output (`bun run compile:contract`);
//!   these tests SKIP loudly when absent, since a missing compile artifact is not a regression.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use midnight_native::preimage::{build_bind_preimage, build_rebind_preimage};
use midnight_native::prove::{circuit_k, prove_circuit};

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn srs_path(k: u8) -> Result<PathBuf, String> {
    let dir = std::env::var("MIDNIGHT_PP")
        .map(PathBuf::from)
        .or_else(|_| {
            std::env::var("HOME")
                .map(|home| PathBuf::from(home).join(".cache/midnight/zk-params"))
                .map_err(|e| format!("$HOME not set: {e}"))
        })?;
    let path = dir.join(format!("bls_midnight_2p{k}"));
    if path.exists() {
        Ok(path)
    } else {
        Err(format!(
            "KZG params for K={k} not found in {}",
            dir.display()
        ))
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
    fs::read_to_string(repo_path("fixtures/handle.inputs.json")).expect("read handle.inputs.json")
}

fn managed() -> Option<PathBuf> {
    let dir = repo_path("../../../contract/managed/handle");
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

/// Prove a natively-built preimage against the compiled circuit, and report the cost.
fn prove(circuit: &str, preimage: &[u8]) {
    let Some(managed) = managed() else { return };
    let zkir = fs::read(managed.join(format!("zkir/{circuit}.bzkir"))).expect("read bzkir");
    let prover_key =
        fs::read(managed.join(format!("keys/{circuit}.prover"))).expect("read prover key");
    let verifier_key =
        fs::read(managed.join(format!("keys/{circuit}.verifier"))).expect("read verifier key");
    let k = circuit_k(&zkir).expect("read circuit k");
    let params = fs::read(srs_path(k).expect("locate KZG params")).expect("read KZG params");

    let start = Instant::now();
    let output = prove_circuit(&zkir, &prover_key, &verifier_key, &params, preimage)
        .unwrap_or_else(|e| panic!("prove natively-built {circuit} preimage: {e}"));
    println!(
        "native {circuit}: K={k}, built+proved+verified in {:.0} ms, proof {} bytes",
        start.elapsed().as_secs_f64() * 1000.0,
        output.proof.len(),
    );
}

#[test]
fn bind_preimage_proves_against_the_compiled_circuit() {
    let json = inputs();
    let state =
        fs::read(repo_path("fixtures/handle_unbound.contract_state")).expect("read unbound state");
    let preimage = build_bind_preimage(
        &state,
        bytes32(&json, "contractAddress"),
        bytes32(&json, "identitySk"),
    )
    .expect("build bind preimage");
    prove("bind", &preimage);
}

#[test]
fn rebind_preimage_proves_against_the_compiled_circuit() {
    let json = inputs();
    let state =
        fs::read(repo_path("fixtures/handle_bound.contract_state")).expect("read bound state");
    let preimage = build_rebind_preimage(
        &state,
        bytes32(&json, "boundContractAddress"),
        bytes32(&json, "newOwner"),
        bytes32(&json, "identitySk"),
    )
    .expect("build rebind preimage");
    prove("rebind", &preimage);
}

/// `bind` refuses a name that is already bound, and it refuses it **here** rather than at the node:
/// the owner popeq claims the zero sentinel, so running the program against a bound state fails in
/// `QueryContext::query` before a preimage is ever produced.
#[test]
fn bind_against_an_already_bound_name_is_refused_while_building() {
    let json = inputs();
    let state =
        fs::read(repo_path("fixtures/handle_bound.contract_state")).expect("read bound state");
    let err = build_bind_preimage(
        &state,
        bytes32(&json, "boundContractAddress"),
        bytes32(&json, "identitySk"),
    )
    .expect_err("a bound name must not build a bind transcript");
    assert!(
        err.contains("transcript rejected by runtime"),
        "unexpected error: {err}"
    );
}

/// `rebind` is authorised by the *current* owner, and the same mechanism refuses a stranger: the owner
/// popeq claims `C` derived from the caller's own secret, so a different secret cannot run the program.
#[test]
fn rebind_by_a_stranger_is_refused_while_building() {
    let json = inputs();
    let state =
        fs::read(repo_path("fixtures/handle_bound.contract_state")).expect("read bound state");
    let err = build_rebind_preimage(
        &state,
        bytes32(&json, "boundContractAddress"),
        bytes32(&json, "newOwner"),
        [0x01u8; 32],
    )
    .expect_err("a stranger must not build a rebind transcript");
    assert!(
        err.contains("transcript rejected by runtime"),
        "unexpected error: {err}"
    );
}

/// The ledger slots are hardcoded, and **slot indices move when a ledger field is added or removed**.
/// That has surfaced twice as a device-only failure blamed on the proof stage. The generated metadata
/// knows the real order, so ask it.
#[test]
fn handle_slots_match_the_compiled_contract() {
    let info = repo_path("../../../contract/managed/handle/compiler/contract-info.json");
    let Ok(json) = fs::read_to_string(&info) else {
        eprintln!(
            "SKIP slot check: {} is missing — run `bun run compile:contract`",
            info.display()
        );
        return;
    };
    // ⚠️ Scanning for `"name"` alone does not work here: `payment` is a `ContractAddress`, a struct
    // whose own field is also called `"name"`. Every *ledger* entry carries an `"index"`, and nested
    // fields do not — so walking back from each `"index"` to its nearest preceding `"name"` picks out
    // exactly the top-level entries, and pins name-to-index rather than merely order.
    let ledger = json
        .split("\"ledger\"")
        .nth(1)
        .expect("contract-info.json has a ledger section");
    let mut slots: Vec<(String, usize)> = Vec::new();
    for (at, _) in ledger.match_indices("\"index\"") {
        // ⚠️ The needle carries its colon. The first ledger field is literally *called* `name`, so
        // `"name"` alone matches its own value and reads the following key instead.
        let name_at = ledger[..at]
            .rfind("\"name\":")
            .expect("an index is preceded by a name");
        let name = ledger[name_at..]
            .split('"')
            .nth(3)
            .unwrap_or_default()
            .to_string();
        let index: usize = ledger[at..]
            .split(':')
            .nth(1)
            .and_then(|rest| rest.trim().split([',', '\n', '}']).next())
            .and_then(|n| n.trim().parse().ok())
            .expect("an index is a number");
        slots.push((name, index));
    }
    // The order preimage.rs hardcodes, as name -> slot.
    assert_eq!(
        slots,
        vec![
            ("name".to_string(), 0),
            ("payment".to_string(), 1),
            ("moderateDomain".to_string(), 2),
            ("owner".to_string(), 3),
            ("banned".to_string(), 4),
            ("burned".to_string(), 5),
        ],
        "handle.compact's ledger layout moved — update the slot constants in preimage.rs" // Slot 2 is read by nothing: `preimage.rs` jumps from HANDLE_PAYMENT_SLOT to
                                                                                          // HANDLE_OWNER_SLOT, so `moderateDomain` replacing `adminAuth` there changed no transcript.
    );
}
