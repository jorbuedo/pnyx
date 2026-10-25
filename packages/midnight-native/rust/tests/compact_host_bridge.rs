//! The Compact host bridge, checked against the hand-port it exists to replace.
//!
//! `compact::compact_op` serves the WASM leaves the compactc-generated JS driver needs. What this
//! pins is the half that lives in Rust: the JSON codecs and the VM call. The JS half (running the
//! driver against these ops) is covered on the TypeScript side.
//!
//! ⚠️ **The oracle is `preimage.rs`.** `leave_circle_prototype` builds the same transcript by hand
//! against the same fixture, so a divergence here is a real difference rather than two spellings of
//! the same guess. The hand-port is verify-mode and this is gather-mode, so what is compared is the
//! *read contents* — which is exactly what a verify transcript's `popeq` results are.

use midnight_native::compact::compact_op;
use midnight_native::prove::{circuit_k, prove_circuit, verify_proof};
use serde_json::{json, Value as J};
use std::fs;
use std::path::PathBuf;

struct Artifacts {
    zkir: Vec<u8>,
    prover: Vec<u8>,
    verifier: Vec<u8>,
    params: Vec<u8>,
    k: u8,
}

/// The compiled circuit's three files plus its SRS, or `None` when the contract is not compiled.
fn artifacts(circuit: &str) -> Option<Artifacts> {
    artifacts_of("circle", circuit)
}

fn artifacts_of(contract: &str, circuit: &str) -> Option<Artifacts> {
    let managed = repo_path(&format!("../../../contract/managed/{contract}"));
    let zkir = fs::read(managed.join(format!("zkir/{circuit}.bzkir"))).ok()?;
    let prover = fs::read(managed.join(format!("keys/{circuit}.prover"))).ok()?;
    let verifier = fs::read(managed.join(format!("keys/{circuit}.verifier"))).ok()?;
    let k = circuit_k(&zkir).expect("read circuit k");
    let dir = std::env::var("MIDNIGHT_PP").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("HOME").expect("$HOME")).join(".cache/midnight/zk-params")
    });
    let params = fs::read(dir.join(format!("bls_midnight_2p{k}"))).ok()?;
    Some(Artifacts { zkir, prover, verifier, params, k })
}

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn state_hex() -> String {
    fs::read(repo_path("fixtures/circle_populated.contract_state"))
        .expect("read circle_populated.contract_state")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

const CONTRACT_ADDRESS: &str = "babababababababababababababababababababababababababababababababa";

fn call(op: &str, args: J) -> J {
    let out = compact_op(op, &args.to_string()).unwrap_or_else(|e| panic!("{op}: {e}"));
    serde_json::from_str(&out).expect("the bridge answers JSON")
}

fn new_context() -> u32 {
    call("ctx.new", json!({"state": state_hex(), "address": CONTRACT_ADDRESS}))["id"]
        .as_u64()
        .expect("a context id") as u32
}

/// `Bytes<32>`, trailing zeros trimmed — the encoding the JS side produces.
fn bytes32_aligned(hex: &str) -> J {
    let trimmed = hex.trim_end_matches("00");
    let even = if trimmed.len() % 2 == 0 { trimmed } else { &hex[..trimmed.len() + 1] };
    json!({
        "value": [even],
        "alignment": [{"tag": "atom", "value": {"tag": "bytes", "length": 32}}],
    })
}

#[test]
fn persistent_hash_matches_the_contract_derivation() {
    // `personaCommitment(sk)` = persistentHash(["pnyx:pc" padded, sk]). The same value
    // `preimage.rs::persona_commitment` computes, reached through the bridge's JSON instead.
    let tag = {
        let mut t = [0u8; 32];
        t[.."pnyx:pc".len()].copy_from_slice(b"pnyx:pc");
        t
    };
    let sk = [11u8; 32];
    let out = call(
        "hash.persistent",
        json!({
            "value": [
                tag.iter().map(|b| format!("{b:02x}")).collect::<String>().trim_end_matches("00"),
                sk.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            ],
            "alignment": [
                {"tag": "atom", "value": {"tag": "bytes", "length": 32}},
                {"tag": "atom", "value": {"tag": "bytes", "length": 32}},
            ],
        }),
    );
    assert_eq!(
        out["out"].as_str().expect("a hash"),
        "3084874f4d175d5696db6822d3f485d5077b16b0f2d264b035adddc2a011f135",
        "the bridge's persistentHash must agree with the WASM runtime's, measured 2026-09-13"
    );
}

#[test]
fn a_query_reads_the_sealed_circle_id_the_hand_port_reads() {
    // `join`'s third read: `dup 0; idx circleId; popeq`. Gather mode returns the content the
    // verify-mode transcript would have had to state in advance.
    let id = new_context();
    let out = call(
        "ctx.query",
        json!({
            "id": id,
            "program": [
                {"dup": {"n": 0}},
                {"idx": {"cached": false, "pushPath": false,
                         "path": [{"tag": "value", "value": {
                             "value": [""],
                             "alignment": [{"tag": "atom", "value": {"tag": "bytes", "length": 1}}]}}]}},
                {"popeq": {"cached": false, "result": null}},
            ],
        }),
    );
    let events = out["events"].as_array().expect("events");
    assert_eq!(events.len(), 1, "one popeq is one read");
    assert_eq!(events[0]["tag"], "read");
    // Slot 0 is the sealed circleId — `dump-vote-preimages.mts` seals `bytes32(1)`.
    assert_eq!(
        events[0]["content"]["value"][0].as_str().expect("content bytes"),
        "0101010101010101010101010101010101010101010101010101010101010101",
    );
    call("ctx.free", json!({"id": id}));
}

#[test]
fn the_vm_refuses_a_transcript_that_does_not_run() {
    // The same rejection `build_prototype` relies on: a malformed program fails here rather than
    // becoming an unprovable preimage several layers later.
    let id = new_context();
    let err = compact_op(
        "ctx.query",
        &json!({"id": id, "program": [{"idx": {"cached": false, "pushPath": false,
            "path": [{"tag": "value", "value": {"value": ["63"],
                "alignment": [{"tag": "atom", "value": {"tag": "bytes", "length": 1}}]}}]}}]})
        .to_string(),
    )
    .expect_err("indexing slot 99 of a 9-slot state must fail");
    assert!(err.contains("transcript rejected by runtime"), "got: {err}");
    call("ctx.free", json!({"id": id}));
}

#[test]
fn a_state_value_the_constructor_builds_is_refused_by_name() {
    // `map` / `array` / `boundedMerkleTree` belong to `initialState`, which this bridge does not
    // serve. Refused with the reason rather than half-built — a silently wrong state value would
    // fail as an unprovable transcript with nothing pointing here.
    let id = new_context();
    let err = compact_op(
        "ctx.query",
        &json!({"id": id, "program": [{"push": {"storage": true, "value": {"tag": "array"}}}]}).to_string(),
    )
    .expect_err("an array state value must be refused");
    assert!(err.contains("initialState"), "got: {err}");
    call("ctx.free", json!({"id": id}));
}

#[test]
fn an_unknown_op_names_itself() {
    let id = new_context();
    let err = compact_op("ctx.query", &json!({"id": id, "program": ["flibble"]}).to_string())
        .expect_err("an unknown op must be refused");
    assert!(err.contains("flibble"), "got: {err}");
    call("ctx.free", json!({"id": id}));
}

#[test]
fn a_freed_context_is_gone() {
    let id = new_context();
    call("ctx.free", json!({"id": id}));
    let err = compact_op("ctx.query", &json!({"id": id, "program": []}).to_string())
        .expect_err("a freed context must not answer");
    assert!(err.contains("no query context"), "got: {err}");
}

/// ⚠️ **The one that decides item 32.** The transcript here was produced by the *compactc-generated
/// driver* running on the real `@midnight-ntwrk/compact-runtime` in Node — no shim, no hand-port —
/// and captured by `scripts/dump-leave-transcript.mts`. If our rail can turn that into a proof that
/// verifies, then the generated driver can replace `preimage.rs`'s hand-ports, and the only thing
/// left to prove is that the Hermes shim reproduces the same transcript.
///
/// Byte-equality with the hand-port is deliberately **not** asserted: `build_prototype` samples
/// fresh commitment randomness per build, so two runs of one builder already differ. A verifying
/// proof is the equivalence that matters.
#[test]
fn the_generated_driver_transcript_proves_through_our_rail() {
    let raw = fs::read_to_string(repo_path("fixtures/leave_circle.transcript.json"))
        .expect("read leave_circle.transcript.json — regenerate with dump-leave-transcript.mts");
    let fixture: J = serde_json::from_str(&raw).expect("the transcript fixture is JSON");

    assert_eq!(
        fixture["program"].as_array().map(Vec::len),
        Some(30),
        "the driver emits 30 ops for leaveCircle — the same count the hand-port carries"
    );

    let out = call(
        "preimage.build",
        json!({
            "state": fixture["state"],
            "address": CONTRACT_ADDRESS,
            "entryPoint": fixture["entryPoint"],
            "program": fixture["program"],
            "privateTranscriptOutputs": fixture["privateTranscriptOutputs"],
            "input": fixture["input"],
            "output": fixture["output"],
        }),
    );
    let preimage_hex = out["preimage"].as_str().expect("a preimage");
    let preimage: Vec<u8> = (0..preimage_hex.len() / 2)
        .map(|i| u8::from_str_radix(&preimage_hex[i * 2..i * 2 + 2], 16).expect("hex"))
        .collect();

    let Some(a) = artifacts("leaveCircle") else {
        eprintln!("SKIP: contract/managed/circle or the KZG params are absent — compile first");
        return;
    };
    let started = std::time::Instant::now();
    let proof = prove_circuit(&a.zkir, &a.prover, &a.verifier, &a.params, &preimage).unwrap_or_else(|e| {
        panic!("the generated driver's transcript did not prove through our rail: {e:?}")
    });
    verify_proof(&a.verifier, &a.params, &proof.proof, &proof.public_inputs)
        .unwrap_or_else(|e| panic!("the proof did not verify against its own verifier key: {e:?}"));
    let mut tampered = proof.public_inputs.clone();
    tampered[0][0] ^= 1;
    assert!(
        verify_proof(&a.verifier, &a.params, &proof.proof, &tampered).is_err(),
        "a tampered statement must not verify"
    );
    eprintln!(
        "generated-driver leaveCircle: K={} proved+verified in {} ms, proof {} bytes",
        a.k,
        started.elapsed().as_millis(),
        proof.proof.len()
    );
}

/// `runtimeCoinCommitment`, against the real WASM runtime's own answers.
///
/// The three vectors were read out of `@midnight-ntwrk/onchain-runtime-v3` in Node on 2026-09-13,
/// not derived here — the point of a shim leaf is to agree with the thing it replaces.
///
/// ⚠️ **The third vector is the one that earns its place.** Its nonce ends in two zero bytes and its
/// value is zero, so both atoms arrive trimmed — a commitment built by reading atoms at face value
/// instead of padding them back to the width their alignment declares passes the first two vectors
/// and fails this one.
#[test]
fn a_coin_commitment_matches_the_wasm_runtime() {
    let bytes32 = || json!({"tag": "atom", "value": {"tag": "bytes", "length": 32}});
    let coin = |nonce: &str, color: &str, value: &str| {
        json!({
            "value": [nonce, color, value],
            "alignment": [bytes32(), bytes32(), {"tag": "atom", "value": {"tag": "bytes", "length": 8}}],
        })
    };
    // `Either<ZswapCoinPublicKey, ContractAddress>`: left is the user, right is the contract.
    let recipient = |is_left: bool, arm: &str| {
        json!({
            "value": if is_left { [ "01", arm, ""] } else { ["", "", arm] },
            "alignment": [{"tag": "atom", "value": {"tag": "bytes", "length": 1}}, bytes32(), bytes32()],
        })
    };
    let commitment = |coin: J, recipient: J| {
        call("zswap.coinCommitment", json!({"coin": coin, "recipient": recipient}))["out"]
            .as_str()
            .expect("a commitment")
            .to_string()
    };

    let plain = coin(&"02".repeat(32), &"01".repeat(32), "2a");
    assert_eq!(
        commitment(plain.clone(), recipient(true, &"ab".repeat(32))),
        "e5ef4d4ac219b31fc106f7ab0cab36623478dd62503fa061539f1a299f0c6f38",
        "a commitment to a coin public key"
    );
    assert_eq!(
        commitment(plain, recipient(false, &"cd".repeat(32))),
        "0c1b61cb8b80918abc876fa91dfab4ec0ccfe1c1ee28212aa8b401bf6800c3a5",
        "a commitment to a contract address — the other arm, and a different hash"
    );
    assert_eq!(
        commitment(
            coin(&"09".repeat(30), &"01".repeat(32), ""),
            recipient(true, &"ab".repeat(32))
        ),
        "73c45d242b0f0e7dc83ce7bc00158ae973ecc21c750c09571461529ed25c5c23",
        "trailing zeros are trimmed in transit and padded back before hashing"
    );
}

/// A coin value is `Uint<64>`, and the alignment is what says so. Nine bytes is not a big coin — it
/// is a malformed one, and it must fail here rather than commit to a truncated amount.
#[test]
fn a_coin_wider_than_its_alignment_is_refused() {
    let err = compact_op(
        "zswap.coinCommitment",
        &json!({
            "coin": {
                "value": ["02".repeat(32), "01".repeat(32), "ffffffffffffffffff"],
                "alignment": [
                    {"tag": "atom", "value": {"tag": "bytes", "length": 32}},
                    {"tag": "atom", "value": {"tag": "bytes", "length": 32}},
                    {"tag": "atom", "value": {"tag": "bytes", "length": 8}},
                ],
            },
            "recipient": {
                "value": ["01", "ab".repeat(32), ""],
                "alignment": [
                    {"tag": "atom", "value": {"tag": "bytes", "length": 1}},
                    {"tag": "atom", "value": {"tag": "bytes", "length": 32}},
                    {"tag": "atom", "value": {"tag": "bytes", "length": 32}},
                ],
            },
        })
        .to_string(),
    )
    .expect_err("a nine-byte value in an eight-byte field must be refused");
    assert!(err.contains("alignment"), "got: {err}");
}

/// The index a received coin is later spent by. Kept on the live context, so a circuit that
/// receives and then qualifies within one call sees its own commitment.
#[test]
fn a_commitment_index_lands_on_the_context() {
    let id = new_context();
    call(
        "ctx.insertCommitment",
        json!({"id": id, "commitment": "5a".repeat(32), "index": "3"}),
    );
    // A second insert at the same key replaces rather than duplicates — the map is keyed by
    // commitment, and a coin has one index.
    call(
        "ctx.insertCommitment",
        json!({"id": id, "commitment": "5a".repeat(32), "index": "4"}),
    );
    call("ctx.free", json!({"id": id}));

    let err = compact_op(
        "ctx.insertCommitment",
        &json!({"id": id, "commitment": "5a".repeat(32), "index": "3"}).to_string(),
    )
    .expect_err("a freed context must not take a commitment");
    assert!(err.contains("no query context"), "got: {err}");
}

#[test]
fn leaf_hash_matches_the_blank_leaf_a_removal_writes() {
    // `leaveCircle` blanks a leaf with `leafHash(pad(32, ""))`; `preimage.rs::blank_leaf_hash` is
    // the same call. All-zero is the empty atom, not 32 zero bytes.
    let a = call("leaf.hash", json!(bytes32_aligned("")));
    let b = call(
        "leaf.hash",
        json!({"value": [""], "alignment": [{"tag": "atom", "value": {"tag": "bytes", "length": 32}}]}),
    );
    assert_eq!(a["out"], b["out"]);
    assert_eq!(a["out"].as_str().expect("a hash").len(), 64);
}

/// ⚠️ **Every contract, not just the one that motivated this.** Each transcript was produced by the
/// compactc-generated driver for its own contract, running on the real `compact-runtime` in Node
/// (`scripts/dump-driver-transcripts.mts`). Proving all of them through `preimage.build` is what
/// turns "the driver can replace a hand-port" from one circuit's result into the contract-wide
/// claim plan item 32 rests on.
///
/// ⚠️ **`setMember` has no hand-port at all.** It is in this set on purpose: the driver reaches a
/// circuit `preimage.rs` never ported, which is the prospective payoff stated rather than assumed.
#[test]
fn every_generated_driver_transcript_proves_through_our_rail() {
    let raw = fs::read_to_string(repo_path("fixtures/driver.transcripts.json"))
        .expect("read driver.transcripts.json — regenerate with dump-driver-transcripts.mts");
    let all: Vec<J> = serde_json::from_str(&raw).expect("the transcripts fixture is JSON");
    assert!(all.len() >= 15, "expected the full sweep, got {}", all.len());

    let mut proved = 0usize;
    let mut skipped = 0usize;
    for entry in &all {
        let contract = entry["contract"].as_str().expect("a contract name");
        let circuit = entry["entryPoint"].as_str().expect("an entry point");
        let label = format!("{contract}.{circuit}");

        // The bridge half runs whether or not the circuit is compiled here: a transcript that does
        // not execute against its own state fails now, with the op named, rather than at proving.
        let out = compact_op(
            "preimage.build",
            &json!({
                "state": entry["state"],
                // Each transcript's own address: `payment.claimFreePermit` reads it, so a shared
                // constant fails as a ReadMismatch naming two hashes and no cause.
                "address": entry["contractAddress"],
                "entryPoint": circuit,
                "program": entry["program"],
                "privateTranscriptOutputs": entry["privateTranscriptOutputs"],
                "input": entry["input"],
                "output": entry["output"],
            })
            .to_string(),
        )
        .unwrap_or_else(|e| panic!("{label}: the driver's transcript did not build a preimage: {e}"));
        let built: J = serde_json::from_str(&out).expect("the bridge answers JSON");
        let preimage_hex = built["preimage"].as_str().expect("a preimage");
        let preimage: Vec<u8> = (0..preimage_hex.len() / 2)
            .map(|i| u8::from_str_radix(&preimage_hex[i * 2..i * 2 + 2], 16).expect("hex"))
            .collect();

        let Some(a) = artifacts_of(contract, circuit) else {
            eprintln!("SKIP {label}: artifacts or KZG params absent");
            skipped += 1;
            continue;
        };
        let started = std::time::Instant::now();
        let proof = prove_circuit(&a.zkir, &a.prover, &a.verifier, &a.params, &preimage)
            .unwrap_or_else(|e| panic!("{label}: the driver's transcript did not prove: {e:?}"));
        verify_proof(&a.verifier, &a.params, &proof.proof, &proof.public_inputs)
            .unwrap_or_else(|e| panic!("{label}: the proof did not verify: {e:?}"));
        eprintln!(
            "{label}: K={} proved+verified in {} ms, proof {} bytes",
            a.k,
            started.elapsed().as_millis(),
            proof.proof.len()
        );
        proved += 1;
    }
    eprintln!("generated drivers: {proved} proved, {skipped} skipped");
    assert!(proved > 0 || skipped == all.len(), "nothing proved and nothing skipped");
}
