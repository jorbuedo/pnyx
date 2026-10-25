//! Build a transfer that pays its own DUST fee, and prove it.
//!
//! The whole self-funding path in one test: price the fee, take DUST from a synced state, attach the
//! dust action, sign, **prove the K=13 `midnight/dust/spend` circuit**, and seal. What makes it worth
//! having as an integration test rather than a unit one is the proving — it is the only step that
//! touches real artifacts, and a wrong resolver mapping or a wrong SRS fails only here.
//!
//! Env-gated because it needs the artifacts on disk:
//! `DUST_ARTIFACTS=<dir with spend.{bzkir,prover,verifier}> DUST_PARAMS=<dir with bls_midnight_2p13> \
//!   cargo test --release --features proving --test self_funded_transfer -- --nocapture`

#![cfg(feature = "proving")]

use bip32::{DerivationPath, XPrv};
use bip39::Mnemonic;
use midnight_base_crypto::hash::HashOutput;
use midnight_base_crypto::time::Timestamp;
use midnight_ledger::dust::{
    DustGenerationInfo, DustLocalState, DustPublicKey, InitialNonce, QualifiedDustOutput,
};
use midnight_ledger::structure::INITIAL_PARAMETERS;
use midnight_native::unshielded::{
    build_self_funded_transfer_json, SelfFundedExtras, UnshieldedInput, UnshieldedTransferRequest,
};
use midnight_serialize::tagged_serialize;

const NIGHT: [u8; 32] = [0u8; 32];

fn role_key(index: u32) -> [u8; 32] {
    let seed = Mnemonic::parse("test test test test test test test test test test test junk")
        .unwrap()
        .to_seed("");
    let path: DerivationPath = format!("m/44'/2400'/0'/{index}/0").parse().unwrap();
    XPrv::derive_from_path(&seed, &path)
        .unwrap()
        .private_key()
        .to_bytes()
        .into()
}

/// A dust state holding one generating entry and the output it backs — enough to pay a fee from.
fn funded_dust_state(dust_role_key: &[u8; 32], night_value: u128, ctime: u64) -> Vec<u8> {
    let sk = midnight_ledger::dust::DustSecretKey::derive_secret_key(dust_role_key);
    let owner = DustPublicKey::from(sk.clone());
    let backing = InitialNonce(HashOutput([7u8; 32]));
    let state = DustLocalState::<midnight_storage::DefaultDB>::new(INITIAL_PARAMETERS.dust);
    let state = state
        .insert_generation_info(
            0,
            DustGenerationInfo {
                value: night_value,
                owner,
                nonce: backing,
                dtime: Timestamp::MAX,
            },
            Some(backing),
        )
        .expect("insert generation info");
    let utxo = QualifiedDustOutput {
        initial_value: 0,
        owner,
        nonce: midnight_ledger::dust::dust_nonce(&backing, 0, &sk),
        seq: 0,
        ctime: Timestamp::from_secs(ctime),
        backing_night: backing,
        mt_index: 0,
    };
    let state = state
        .insert_commitment(0, utxo, true)
        .expect("insert commitment");
    let state = state
        .add_utxo(&utxo.nullifier(&sk), &utxo, None)
        .expect("add utxo");
    let mut out = Vec::new();
    tagged_serialize(&state, &mut out).expect("serialize");
    out
}

#[test]
fn a_transfer_pays_its_own_fee_and_comes_out_sealed() {
    let (Ok(artifacts), Ok(params)) = (
        std::env::var("DUST_ARTIFACTS"),
        std::env::var("DUST_PARAMS"),
    ) else {
        eprintln!("SKIP: set DUST_ARTIFACTS and DUST_PARAMS to run this");
        return;
    };

    let night_key = role_key(0);
    let dust_key = role_key(1);
    // Created a year before the transfer, so a large amount of DUST has accrued towards the cap.
    let created = 1_700_000_000u64;
    let now = created + 365 * 24 * 3600;
    let dust_state = funded_dust_state(&dust_key, 5_000_000_000_000, created);

    let inputs = [UnshieldedInput {
        value: 2_000_000,
        token_type: NIGHT,
        intent_hash: [1u8; 32],
        output_no: 0,
    }];
    let request = UnshieldedTransferRequest {
        night_role_key: &night_key,
        inputs: &inputs,
        recipient_address: [9u8; 32],
        token_type: NIGHT,
        value: 1_000_000,
        network_id: "undeployed",
        ttl_secs: now + 3600,
        // 1 keeps the single change output this test was written against. The field arrived with
        // NIGHT's self-spreading change and every caller was updated except this one, so the file
        // stopped compiling and `cargo test` with no filter has failed since.
        change_chunks: 1,
    };
    let extras = SelfFundedExtras {
        dust_state: &dust_state,
        dust_role_key: &dust_key,
        ctime_secs: now,
        artifact_dir: &artifacts,
        params_dir: &params,
        fee_margin: 2,
    };

    let started = std::time::Instant::now();
    let json =
        build_self_funded_transfer_json(request, extras).expect("build a self-funded transfer");
    let elapsed = started.elapsed();

    let fee = json
        .split("\"fee\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("a fee in the result");
    let tx_hex = json
        .split("\"tx\":\"")
        .nth(1)
        .and_then(|r| r.split('"').next())
        .expect("tx");
    let state_hex = json
        .split("\"state\":\"")
        .nth(1)
        .and_then(|r| r.split('"').next())
        .expect("state");

    println!(
        "fee {fee} SPECK, tx {} bytes, proved+sealed in {elapsed:?}",
        tx_hex.len() / 2
    );

    assert_ne!(
        fee, "0",
        "an idle-chain zero fee would skip the dust action and prove nothing"
    );
    assert!(tx_hex.len() > 2, "a transaction came back");
    // The dust state must have moved: the spent output is pending now, and persisting the old one
    // would let the next transfer pick the same output.
    assert_ne!(
        state_hex,
        hex::encode(&dust_state),
        "the dust state must change when DUST is spent"
    );
}
