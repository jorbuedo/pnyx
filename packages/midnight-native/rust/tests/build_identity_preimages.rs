//! Native preimage construction for every `identity.compact` circuit: build the `ProofPreimage`
//! entirely in Rust, then prove + verify it host-side against the compiled artifacts.
//!
//! **A verifying proof is the correctness oracle.** The transcripts in `preimage.rs` are written by
//! hand — the device has no Compact runtime to generate them, because `compact-runtime` cannot bundle
//! for Android — so a drifted op is not a compile error anywhere. It surfaces at the node as
//! "Public transcript input mismatch for input 9" with no clue which op moved. A malformed preimage
//! will not prove, so proving here is what makes the port trustworthy.
//!
//! Every branch gets its own case, because a branch is five or nine ops present or absent:
//! `setRow` writing vs clearing, and `setRows` clearing a slot that is **present** vs one that is
//! **absent** — the last emits the `member` popeq and then nothing at all, which is the shape a
//! hand-written builder is most likely to get wrong.
//!
//! Artifacts:
//! - `fixtures/identity_*.contract_state`, `fixtures/identity.inputs.json` — committed; regenerate
//!   with `node --import tsx packages/midnight-native/scripts/dump-identity-fixtures.mts`.
//! - `contract/managed/identity/{zkir,keys}` — gitignored compile output (`bun run compile:contract`);
//!   these tests SKIP loudly when absent, since a missing compile artifact is not a regression.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use midnight_native::preimage::{
    build_publish_row_preimage, build_set_primary_name_preimage, build_set_row_preimage,
    build_set_rows_preimage, CardWrite,
};
use midnight_native::prove::{circuit_k, prove_circuit};
use midnight_native::state_read::{
    ANCHOR_SLOT, AUTH_PUB_SLOT, CARD_SLOT, ID_SLOT, PRIMARY_NAME_SLOT,
};

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
        // A number, so read to the delimiter.
        None => rest[..rest.find([',', '\n', '}']).expect("delimiter")]
            .trim()
            .to_string(),
    }
}

/// `contractAddress` and `identitySk` from the fixture generator.
fn inputs() -> ([u8; 32], [u8; 32]) {
    let json = fs::read_to_string(repo_path("fixtures/identity.inputs.json"))
        .expect("read identity.inputs.json");
    let addr: [u8; 32] = hex::decode(field(&json, "contractAddress"))
        .expect("hex")
        .try_into()
        .expect("32 bytes");
    let sk: [u8; 32] = hex::decode(field(&json, "identitySk"))
        .expect("hex")
        .try_into()
        .expect("32 bytes");
    (addr, sk)
}

fn managed() -> Option<PathBuf> {
    let dir = repo_path("../../../contract/managed/identity");
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

/// A 320-byte card row value, as `card.ts` lays one out: a two-byte big-endian length, the bytes,
/// then zero padding. Built here rather than imported because the point is to feed the Rust builder
/// the same shape the client produces.
fn card_value(text: &str) -> Vec<u8> {
    let mut out = vec![0u8; 320];
    let bytes = text.as_bytes();
    out[0] = (bytes.len() >> 8) as u8;
    out[1] = (bytes.len() & 0xff) as u8;
    out[2..2 + bytes.len()].copy_from_slice(bytes);
    out
}

/// The ledger slots are hardcoded, and **slot indices move when a ledger field is added or removed**.
/// That has surfaced twice as a device-only failure blamed on the proof stage. The generated metadata
/// knows the real order, so ask it.
#[test]
fn identity_slots_match_the_compiled_contract() {
    let info = repo_path("../../../contract/managed/identity/compiler/contract-info.json");
    let Ok(json) = fs::read_to_string(&info) else {
        eprintln!(
            "SKIP slot check: {} is missing — run `bun run compile:contract`",
            info.display()
        );
        return;
    };
    // The ledger array is ordered, so a field's position in it *is* its slot.
    let ledger = json
        .split("\"ledger\"")
        .nth(1)
        .expect("contract-info.json has a ledger section");
    let names: Vec<String> = ledger
        .match_indices("\"name\"")
        .map(|(at, _)| {
            ledger[at..]
                .split('"')
                .nth(3)
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    let slot_of = |field: &str| {
        names
            .iter()
            .position(|n| n == field)
            .unwrap_or_else(|| panic!("contract-info.json names no `{field}` field"))
    };

    assert_eq!(
        slot_of("id"),
        ID_SLOT as usize,
        "ID_SLOT moved; update state_read.rs"
    );
    assert_eq!(
        slot_of("anchor"),
        ANCHOR_SLOT as usize,
        "ANCHOR_SLOT moved; update state_read.rs"
    );
    assert_eq!(
        slot_of("authPub"),
        AUTH_PUB_SLOT as usize,
        "AUTH_PUB_SLOT moved; update state_read.rs"
    );
    assert_eq!(
        slot_of("primaryName"),
        PRIMARY_NAME_SLOT as usize,
        "PRIMARY_NAME_SLOT moved; update state_read.rs"
    );
    assert_eq!(
        slot_of("card"),
        CARD_SLOT as usize,
        "CARD_SLOT moved; update state_read.rs"
    );
}

#[test]
fn publish_row_proves_from_a_fresh_contract() {
    if managed().is_none() {
        return;
    }
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_constructed.contract_state")).expect("read state");
    let preimage =
        build_publish_row_preimage(&state, address, [0x70u8; 32], [0x71u8; 32], sk).expect("build");
    prove("publishRow", &preimage);
}

#[test]
fn publish_row_proves_as_a_rotation_too() {
    // The predecessor circuit needed a *second* transcript for this, because it branched on
    // `identities.member(id)`. With one contract per identity the cells always exist, so a rotation
    // is the same nine ops — and this is what pins that claim rather than asserting it.
    if managed().is_none() {
        return;
    }
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_published.contract_state")).expect("read state");
    let preimage =
        build_publish_row_preimage(&state, address, [0x80u8; 32], [0x81u8; 32], sk).expect("build");
    prove("publishRow", &preimage);
}

#[test]
fn set_primary_name_proves() {
    if managed().is_none() {
        return;
    }
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_published.contract_state")).expect("read state");
    let mut handle = [0u8; 32];
    handle[..6].copy_from_slice(b"zephyr");
    let preimage = build_set_primary_name_preimage(&state, address, handle, sk).expect("build");
    prove("setPrimaryName", &preimage);
}

#[test]
fn set_row_proves_when_writing_an_empty_slot() {
    if managed().is_none() {
        return;
    }
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_published.contract_state")).expect("read state");
    let preimage = build_set_row_preimage(
        &state,
        address,
        0,
        11,
        &card_value("written by the rust builder"),
        sk,
    )
    .expect("build");
    prove("setRow", &preimage);
}

#[test]
fn set_row_proves_when_overwriting_a_full_slot() {
    if managed().is_none() {
        return;
    }
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_card.contract_state")).expect("read state");
    let preimage =
        build_set_row_preimage(&state, address, 0, 9, &card_value("replaced"), sk).expect("build");
    prove("setRow", &preimage);
}

#[test]
fn set_row_proves_when_clearing_a_present_slot() {
    if managed().is_none() {
        return;
    }
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_card.contract_state")).expect("read state");
    let preimage = build_set_row_preimage(&state, address, 0, 0, &[0u8; 320], sk).expect("build");
    prove("setRow", &preimage);
}

#[test]
fn set_row_refuses_to_clear_an_absent_slot_rather_than_building_a_transcript_the_node_rejects() {
    // The circuit asserts "no such row", so this cannot prove. Failing in the builder — with a
    // message naming the slot — beats failing at the node with a transcript error.
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_published.contract_state")).expect("read state");
    let err =
        build_set_row_preimage(&state, address, 30, 0, &[0u8; 320], sk).expect_err("must refuse");
    assert!(err.contains("holds no row"), "got: {err}");
}

#[test]
fn set_row_refuses_a_slot_past_the_contract_cap() {
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_published.contract_state")).expect("read state");
    let err = build_set_row_preimage(&state, address, 64, 8, &card_value("x"), sk)
        .expect_err("must refuse");
    assert!(err.contains("out of range"), "got: {err}");
}

#[test]
fn set_rows_proves_four_writes() {
    if managed().is_none() {
        return;
    }
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_published.contract_state")).expect("read state");
    let writes: Vec<CardWrite> = (0..4)
        .map(|i| CardWrite {
            slot: i,
            kind: 8 + i,
            value: card_value(&format!("row {i}")),
        })
        .collect();
    let preimage = build_set_rows_preimage(&state, address, &writes, sk).expect("build");
    prove("setRows", &preimage);
}

#[test]
fn set_rows_proves_with_clears_of_present_slots() {
    if managed().is_none() {
        return;
    }
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_card.contract_state")).expect("read state");
    // Slots 0..4 are occupied in this fixture, so both clears take the present arm.
    let writes = vec![
        CardWrite {
            slot: 0,
            kind: 8,
            value: card_value("kept"),
        },
        CardWrite {
            slot: 1,
            kind: 9,
            value: card_value("kept too"),
        },
        CardWrite {
            slot: 2,
            kind: 0,
            value: vec![0u8; 320],
        },
        CardWrite {
            slot: 3,
            kind: 0,
            value: vec![0u8; 320],
        },
    ];
    let preimage = build_set_rows_preimage(&state, address, &writes, sk).expect("build");
    prove("setRows", &preimage);
}

#[test]
fn set_rows_proves_with_clears_of_absent_slots() {
    // The shape most likely to be got wrong: `writeSlot`'s clear arm emits the `member` popeq
    // (false) and then **nothing**. A builder that emitted the removal ops anyway would fail here.
    if managed().is_none() {
        return;
    }
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_published.contract_state")).expect("read state");
    let writes = vec![
        CardWrite {
            slot: 0,
            kind: 8,
            value: card_value("written"),
        },
        CardWrite {
            slot: 1,
            kind: 9,
            value: card_value("also written"),
        },
        CardWrite {
            slot: 40,
            kind: 0,
            value: vec![0u8; 320],
        },
        CardWrite {
            slot: 41,
            kind: 0,
            value: vec![0u8; 320],
        },
    ];
    let preimage = build_set_rows_preimage(&state, address, &writes, sk).expect("build");
    prove("setRows", &preimage);
}

#[test]
fn set_rows_tracks_presence_within_one_batch() {
    // A slot written by an earlier arm is present for a later arm that clears it, and the transcript
    // has to say so — `writeSlot` runs against the state its predecessors left behind, not against the
    // state the call started from. Reading presence once up front gets this wrong.
    if managed().is_none() {
        return;
    }
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_published.contract_state")).expect("read state");
    let writes = vec![
        CardWrite {
            slot: 5,
            kind: 8,
            value: card_value("written then cleared"),
        },
        CardWrite {
            slot: 5,
            kind: 0,
            value: vec![0u8; 320],
        },
        CardWrite {
            slot: 6,
            kind: 9,
            value: card_value("stays"),
        },
        CardWrite {
            slot: 7,
            kind: 0,
            value: vec![0u8; 320],
        },
    ];
    let preimage = build_set_rows_preimage(&state, address, &writes, sk).expect("build");
    prove("setRows", &preimage);
}

#[test]
fn set_rows_requires_exactly_the_template_width() {
    let (address, sk) = inputs();
    let state =
        fs::read(repo_path("fixtures/identity_row_published.contract_state")).expect("read state");
    let writes = vec![CardWrite {
        slot: 0,
        kind: 8,
        value: card_value("lonely"),
    }];
    let err = build_set_rows_preimage(&state, address, &writes, sk).expect_err("must refuse");
    assert!(err.contains("exactly 4"), "got: {err}");
}
