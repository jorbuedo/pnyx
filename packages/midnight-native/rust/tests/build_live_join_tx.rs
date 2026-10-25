//! Build a proven-unbound `join` tx against LIVE chain state with the native builders —
//! the host end of the device-rail bisect: if these bytes land via `POST /chain/submit` the native
//! assembly is good for the running node, and any device failure is in the platform bridge; if
//! they are rejected the drift is native-assembly vs node, not the bridge.
//!
//! Env-gated (SKIPs unless `LIVE_STATE_FILE` is set):
//!   LIVE_STATE_FILE   raw serialized ContractState bytes (not hex)
//!   LIVE_ADDRESS_HEX  32-byte contract address
//!   LIVE_PERSONA_HEX  32-byte persona secret
//!   LIVE_CIRCLE_ID    decimal circle id
//!   LIVE_NETWORK      network id string ("undeployed" for the local stack)
//!   LIVE_TTL_SECS     absolute intent expiry, unix seconds
//!   LIVE_OUT_FILE     where to write the tagged tx bytes

use std::fs;
use std::path::PathBuf;

use midnight_native::preimage::build_join_proven_tx;
use midnight_native::prove::circuit_k;

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn srs_path(k: u8) -> PathBuf {
    let dir = std::env::var("MIDNIGHT_PP")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("HOME").expect("$HOME")).join(".cache/midnight/zk-params")
        });
    dir.join(format!("bls_midnight_2p{k}"))
}

fn hex32(name: &str) -> [u8; 32] {
    let hex = std::env::var(name).unwrap_or_else(|_| panic!("{name} not set"));
    let bytes = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect::<Vec<_>>();
    bytes.try_into().expect("32 bytes")
}

#[test]
fn builds_a_join_tx_against_live_state() {
    let Ok(state_file) = std::env::var("LIVE_STATE_FILE") else {
        eprintln!("SKIP: LIVE_STATE_FILE not set (this test targets a running local stack)");
        return;
    };
    let state = fs::read(&state_file).expect("read live state");
    let address = hex32("LIVE_ADDRESS_HEX");
    let persona = hex32("LIVE_PERSONA_HEX");
    let identity = hex32("LIVE_IDENTITY_HEX");
    // A `Bytes<32>` constructor argument now, not a counter — the circle is its own contract.
    let circle_id = hex32("LIVE_CIRCLE_ID_HEX");
    let network = std::env::var("LIVE_NETWORK").expect("LIVE_NETWORK");
    let ttl_secs: u64 = std::env::var("LIVE_TTL_SECS")
        .expect("LIVE_TTL_SECS")
        .parse()
        .expect("ttl");
    let out_file = std::env::var("LIVE_OUT_FILE").expect("LIVE_OUT_FILE");

    let managed = repo_path("../../../contract/managed/circle");
    let zkir = fs::read(managed.join("zkir/join.bzkir")).expect("zkir");
    let prover = fs::read(managed.join("keys/join.prover")).expect("prover key");
    let verifier = fs::read(managed.join("keys/join.verifier")).expect("verifier key");
    let k = circuit_k(&zkir).expect("circuit k");
    let params = fs::read(srs_path(k)).expect("SRS");

    let tx = build_join_proven_tx(
        &state, address, circle_id, None, identity, persona, &zkir, &prover, &verifier, &params,
        &network, ttl_secs,
    )
    .expect("build proven tx");
    fs::write(&out_file, &tx).expect("write tx");
    println!("proven tx: {} bytes -> {out_file}", tx.len());
}
