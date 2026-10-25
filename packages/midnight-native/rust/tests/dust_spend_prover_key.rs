//! Generate the DUST spend circuit's prover key, and check it against upstream's pinned hash.
//!
//! Paying a Midnight fee proves `midnight/dust/spend`, and the ledger crate ships that circuit's
//! `spend.zkir`, `spend.bzkir` and `spend.verifier` but **not** its prover key — only a
//! `spend.prover.sha256`. The key does not have to be obtained from anywhere, though: it is a
//! preprocessing of the circuit against the KZG SRS, and `Zkir::keygen` is public. So this derives it
//! and proves the derivation is right by matching upstream's own hash.
//!
//! That matters beyond convenience: a prover key sourced from a third party has to be trusted, while
//! one regenerated from a circuit in the crate and checked against a hash in the crate is verifiable
//! end to end.
//!
//! Env-gated because it needs the K=13 SRS on disk and takes seconds:
//! `DUST_SRS=<path to bls_midnight_2p13> DUST_ZKIR=<path to static/dust/spend.zkir> \
//!   cargo test --features proving --test dust_spend_prover_key -- --nocapture`

#![cfg(feature = "proving")]

use midnight_serialize::{tagged_deserialize, tagged_serialize};
use midnight_transient_crypto::proofs::{ParamsProver, ParamsProverProvider, Zkir};
use midnight_zkir::IrSource;
use sha2::{Digest, Sha256};
use std::io;

/// The SRS as a fixed provider — the circuit's own `k()` decides which it needs, and we hand it one.
struct FixedParams(ParamsProver);

impl ParamsProverProvider for FixedParams {
    async fn get_params(&self, _k: u8) -> io::Result<ParamsProver> {
        Ok(self.0.clone())
    }
}

#[test]
fn the_generated_prover_key_matches_upstreams_hash() {
    let (Ok(zkir_path), Ok(srs_path)) = (std::env::var("DUST_ZKIR"), std::env::var("DUST_SRS"))
    else {
        eprintln!("SKIP: set DUST_ZKIR and DUST_SRS to run this");
        return;
    };
    let zkir_bytes = std::fs::read(&zkir_path).expect("read the dust spend zkir");
    let srs_bytes = std::fs::read(&srs_path).expect("read the KZG SRS");

    let ir: IrSource = tagged_deserialize(&mut &zkir_bytes[..]).expect("deserialize the zkir");
    let k = ir.k();
    println!("dust/spend: K={k}");

    let params = FixedParams(ParamsProver::read(&srs_bytes[..]).expect("read the SRS"));
    let (pk, vk) = futures::executor::block_on(ir.keygen(&params)).expect("keygen");

    let mut pk_bytes = Vec::new();
    tagged_serialize(&pk, &mut pk_bytes).expect("serialize the prover key");
    let mut vk_bytes = Vec::new();
    tagged_serialize(&vk, &mut vk_bytes).expect("serialize the verifier key");

    let pk_hash = hex::encode(Sha256::digest(&pk_bytes));
    let vk_hash = hex::encode(Sha256::digest(&vk_bytes));
    println!("prover key:   {} bytes, sha256 {pk_hash}", pk_bytes.len());
    println!("verifier key: {} bytes, sha256 {vk_hash}", vk_bytes.len());

    if let Ok(expected) = std::env::var("DUST_PROVER_SHA256") {
        assert_eq!(
            pk_hash, expected,
            "the generated prover key must match upstream's pinned hash"
        );
        println!("MATCHES upstream's pinned hash");
    }
    std::fs::write("/tmp/dust-spend.prover", &pk_bytes).expect("write the prover key");
    println!("wrote /tmp/dust-spend.prover");
}
