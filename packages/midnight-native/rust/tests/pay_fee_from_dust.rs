//! One wallet pays another's transaction fee, end to end, with a real proof.
//!
//! The transaction is built by one key and paid for by a wholly different one — no shared seed, no
//! shared account, nothing in the transaction naming its payer. That is the case the module exists
//! for: a dApp's transaction over the connector, an agent's over MCP, or simply a second wallet's.
//!
//! What only this test covers is the proving and the merge: `midnight/dust/spend` at K=13 against real
//! artifacts, then the two halves joined and sealed. A wrong resolver mapping, a wrong SRS, or a fee
//! priced against the wrong shape fails only here.
//!
//! Env-gated because it needs the artifacts on disk:
//! `DUST_ARTIFACTS=<dir with spend.{bzkir,prover,verifier}> DUST_PARAMS=<dir with bls_midnight_2p13> \
//!   cargo test --release --features proving --test pay_fee_from_dust -- --nocapture`

#![cfg(feature = "proving")]

use midnight_base_crypto::hash::HashOutput;
use midnight_base_crypto::signatures::Signature;
use midnight_base_crypto::time::Timestamp;
use midnight_ledger::dust::{
    dust_nonce, DustGenerationInfo, DustLocalState, DustPublicKey, InitialNonce,
    QualifiedDustOutput,
};
use midnight_ledger::structure::{ProofMarker, Transaction, INITIAL_PARAMETERS};
use midnight_native::fee::{pay_fee_from_dust_json, DustFeeRequest};
use midnight_native::unshielded::{
    build_unshielded_transfer_tx, UnshieldedInput, UnshieldedTransferRequest,
};
use midnight_serialize::{tagged_deserialize, tagged_serialize};
use midnight_storage::DefaultDB;
use midnight_transient_crypto::commitment::{PedersenRandomness, PureGeneratorPedersen};

const NIGHT: [u8; 32] = [0u8; 32];
const CREATED: u64 = 1_700_000_000;
const NOW: u64 = CREATED + 365 * 24 * 3600;

/// The wallet that builds the transaction. It holds NIGHT and no DUST, and never learns who paid.
const AUTHOR_NIGHT_KEY: [u8; 32] = [7u8; 32];
/// A different wallet entirely — a different seed phrase, in the case this exists for. It holds DUST.
const PAYER_DUST_KEY: [u8; 32] = [5u8; 32];

type Unbound = Transaction<Signature, ProofMarker, PedersenRandomness, DefaultDB>;
type Sealed = Transaction<Signature, ProofMarker, PureGeneratorPedersen, DefaultDB>;

/// A DUST state holding one generating entry and the output it backs — enough to pay a fee from.
fn funded_dust_state(dust_role_key: &[u8; 32], night_value: u128) -> Vec<u8> {
    let sk = midnight_ledger::dust::DustSecretKey::derive_secret_key(dust_role_key);
    let owner = DustPublicKey::from(sk.clone());
    let backing = InitialNonce(HashOutput([7u8; 32]));
    let state = DustLocalState::<DefaultDB>::new(INITIAL_PARAMETERS.dust)
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
        nonce: dust_nonce(&backing, 0, &sk),
        seq: 0,
        ctime: Timestamp::from_secs(CREATED),
        backing_night: backing,
        mt_index: 0,
    };
    let state = state
        .insert_commitment(0, utxo, true)
        .expect("insert commitment")
        .add_utxo(&utxo.nullifier(&sk), &utxo, None)
        .expect("add utxo");
    let mut out = Vec::new();
    tagged_serialize(&state, &mut out).expect("serialize");
    out
}

fn a_transfer_by_the_author() -> Vec<u8> {
    build_unshielded_transfer_tx(UnshieldedTransferRequest {
        night_role_key: &AUTHOR_NIGHT_KEY,
        inputs: &[UnshieldedInput {
            value: 2_000_000,
            token_type: NIGHT,
            intent_hash: [1u8; 32],
            output_no: 0,
        }],
        recipient_address: [9u8; 32],
        token_type: NIGHT,
        value: 1_000_000,
        network_id: "undeployed",
        ttl_secs: NOW + 3600,
        change_chunks: 1,
    })
    .expect("build a transfer")
}

fn field<'a>(json: &'a str, key: &str) -> &'a str {
    json.split(&format!("\"{key}\":\""))
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or_else(|| panic!("a {key} in the result: {json:.200}"))
}

#[test]
fn a_second_wallet_pays_for_a_transaction_it_did_not_build() {
    let (Ok(artifacts), Ok(params)) = (
        std::env::var("DUST_ARTIFACTS"),
        std::env::var("DUST_PARAMS"),
    ) else {
        eprintln!("SKIP: set DUST_ARTIFACTS and DUST_PARAMS to run this");
        return;
    };

    let base_bytes = a_transfer_by_the_author();
    let dust_state = funded_dust_state(&PAYER_DUST_KEY, 5_000_000_000_000);

    let started = std::time::Instant::now();
    let json = pay_fee_from_dust_json(DustFeeRequest {
        transaction: &base_bytes,
        dust_state: &dust_state,
        dust_role_key: &PAYER_DUST_KEY,
        ctime_secs: NOW,
        ttl_secs: NOW + 3600,
        artifact_dir: &artifacts,
        params_dir: &params,
        fee_margin: 2,
    })
    .expect("pay the fee");
    let elapsed = started.elapsed();

    let fee: u128 = field(&json, "fee").parse().expect("a decimal fee");
    let paid: u128 = field(&json, "paid").parse().expect("a decimal payment");
    let tx_hex = field(&json, "tx");
    let state_hex = field(&json, "state");
    println!(
        "fee {fee} SPECK, paid {paid}, tx {} bytes, proved+merged+sealed in {elapsed:?}",
        tx_hex.len() / 2
    );

    assert!(
        paid > 0,
        "an idle-chain zero fee would attach no dust action and prove nothing"
    );
    assert_eq!(
        paid, fee,
        "the transfer carried no DUST of its own, so the payer covers the whole bill"
    );
    assert_ne!(
        state_hex,
        hex::encode(&dust_state),
        "the DUST state must move: persisting the old one would let the next fee reuse the spent output"
    );

    // Sealed, not unbound. This is the difference between bytes a node accepts and bytes that still
    // need somebody to bind them.
    let tx_bytes = hex::decode(tx_hex).expect("hex");
    let sealed: Sealed =
        tagged_deserialize(&mut &tx_bytes[..]).expect("a sealed transaction comes back");
    let as_unbound: Result<Unbound, _> = tagged_deserialize(&mut &tx_bytes[..]);
    as_unbound.expect_err("a sealed transaction must not read back as a pre-binding one");

    let Transaction::Standard(stx) = &sealed else {
        panic!("a standard transaction")
    };
    assert_eq!(
        stx.intents().count(),
        2,
        "the author's intent and the payer's, side by side"
    );
    assert!(
        stx.intents.get(&1).is_some(),
        "the author's transfer stayed at segment 1"
    );
    assert!(
        stx.intents.get(&2).is_some(),
        "the fee landed at the first free segment"
    );

    // ⚠️ The assertion the whole design rests on. Signature verification reads the intent in its
    // proof- and signature-erased form, so if *that* is unchanged by merging and sealing, every
    // signature the author put on it is still valid — and the payer never needed a key of theirs.
    let base: Unbound = tagged_deserialize(&mut &base_bytes[..]).expect("the base transaction");
    let Transaction::Standard(before) = &base.erase_proofs() else {
        panic!("a standard transaction")
    };
    let Transaction::Standard(after) = &sealed.erase_proofs() else {
        panic!("a standard transaction")
    };
    assert_eq!(
        *before.intents.get(&1).expect("the author's intent"),
        *after.intents.get(&1).expect("the author's intent, after"),
        "merging and sealing must leave the author's intent identical as signatures see it"
    );

    // The ledger's own verdict, not ours: at the fee we charged, nothing is owed in DUST.
    let balance = sealed
        .balance(Some(fee))
        .expect("balance the sealed transaction");
    let dust = balance
        .get(&(midnight_coin_structure::coin::TokenType::Dust, 0))
        .copied()
        .unwrap_or(0);
    assert!(
        dust >= 0,
        "the sealed transaction still owes {dust} DUST at a fee of {fee}"
    );
}
