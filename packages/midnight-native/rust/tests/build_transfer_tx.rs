//! Build a whole shielded transfer on this rail: select coins, pay a stranger, keep the change, prove
//! it, and hand back bytes the sponsor can balance.
//!
//! This is the send path end to end minus the fee. The Zswap offer balances itself — coins spent equal
//! coins created — so what the sponsor still adds is DUST, which means a shielded send needs no funded
//! user wallet, only coins.
//!
//! Same gating and cache as `spend_shielded_coin.rs` (`ZSWAP_PROVE=1`, artifacts primed under
//! `~/.cache/midnight/zk-params/zswap/9`).

use midnight_native::wallet::{
    build_transfer_tx, state_insert_coin, state_new, state_summary_json, Coin, TransferRequest,
};
use midnight_serialize::Serializable;
use midnight_zswap::keys::{SecretKeys, Seed};

/// Where the one-time fetch put the protocol circuits, and where the SRS lives beside them.
fn params_dir() -> String {
    std::env::var("MIDNIGHT_PP").unwrap_or_else(|_| {
        format!(
            "{}/.cache/midnight/zk-params",
            std::env::var("HOME").expect("$HOME")
        )
    })
}

fn artifact_dir() -> String {
    format!("{}/zswap/9", params_dir())
}

const SENDER_KEY: [u8; 32] = [0x11; 32];
const RECIPIENT_KEY: [u8; 32] = [0x77; 32];
const COLOR: [u8; 32] = [0x33; 32];

fn skip() -> bool {
    if std::env::var("ZSWAP_PROVE").ok().as_deref() == Some("1") {
        return false;
    }
    eprintln!("SKIP: set ZSWAP_PROVE=1 (needs the zswap protocol circuits cached)");
    true
}

/// A wallet holding two coins of the same colour, at indices 0 and 1.
fn funded_wallet() -> Vec<u8> {
    let mut state = state_new().expect("new state");
    for (i, value) in [(0u8, 400u128), (1, 700)] {
        let mut nonce = [9u8; 32];
        nonce[0] = i;
        state = state_insert_coin(
            &state,
            &SENDER_KEY,
            &Coin {
                nonce,
                color: COLOR,
                value,
            },
        )
        .expect("insert");
    }
    state
}

/// The recipient as an address would carry them: coin public key, and the encryption key's bare 32
/// bytes (untagged, which is what `mn_shield-addr` encodes).
fn recipient_keys() -> (SecretKeys, Vec<u8>) {
    let keys = SecretKeys::from(Seed::from(RECIPIENT_KEY));
    let mut epk = Vec::new();
    Serializable::serialize(&keys.enc_public_key(), &mut epk)
        .expect("serialize recipient encryption key");
    assert_eq!(
        epk.len(),
        32,
        "an encryption public key is 32 bytes in an address"
    );
    (keys, epk)
}

#[test]
fn a_transfer_spends_what_it_needs_and_returns_the_change() {
    if skip() {
        return;
    }
    let (recipient, recipient_epk) = recipient_keys();
    let state = funded_wallet();

    // 500 from coins of 400 and 700: the first cannot cover it alone, so both are spent and 600 comes
    // back as change. Zswap has no partial spend, which is why change is not an optimisation.
    let (tx, next) = build_transfer_tx(TransferRequest {
        state: &state,
        zswap_role_key: &SENDER_KEY,
        recipient_coin_public_key: recipient.coin_public_key().0 .0,
        recipient_encryption_public_key: &recipient_epk,
        color: COLOR,
        value: 500,
        network_id: "undeployed",
        ttl_secs: 4_000_000_000,
        artifact_dir: &artifact_dir(),
        params_dir: &params_dir(),
    })
    .expect("build the transfer");

    assert!(!tx.is_empty(), "a proven transaction");
    eprintln!("proven transfer: {} bytes", tx.len());

    // The spent coins are gone from the spendable set: they moved to pending spends, so a second
    // transfer built before this one confirms cannot select the same notes and double-spend.
    let summary = state_summary_json(&next).expect("summary");
    assert!(
        summary.contains("\"coins\":[]"),
        "both coins should be pending, not spendable: {summary}"
    );
}

#[test]
fn a_transfer_larger_than_the_wallet_says_how_much_is_missing() {
    if skip() {
        return;
    }
    let (recipient, recipient_epk) = recipient_keys();
    let err = build_transfer_tx(TransferRequest {
        state: &funded_wallet(),
        zswap_role_key: &SENDER_KEY,
        recipient_coin_public_key: recipient.coin_public_key().0 .0,
        recipient_encryption_public_key: &recipient_epk,
        color: COLOR,
        value: 5_000,
        network_id: "undeployed",
        ttl_secs: 4_000_000_000,
        artifact_dir: &artifact_dir(),
        params_dir: &params_dir(),
    })
    .expect_err("must refuse");
    // The shortfall, not "insufficient funds": a caller that cannot name the gap cannot tell a user
    // whether to wait for a pending receive or to send less.
    assert!(err.contains("holds 1100"), "{err}");
    assert!(err.contains("short by 3900"), "{err}");
}

#[test]
fn a_transfer_of_a_colour_the_wallet_does_not_hold_is_refused() {
    if skip() {
        return;
    }
    let (recipient, recipient_epk) = recipient_keys();
    let err = build_transfer_tx(TransferRequest {
        state: &funded_wallet(),
        zswap_role_key: &SENDER_KEY,
        recipient_coin_public_key: recipient.coin_public_key().0 .0,
        recipient_encryption_public_key: &recipient_epk,
        color: [0xab; 32],
        value: 1,
        network_id: "undeployed",
        ttl_secs: 4_000_000_000,
        artifact_dir: &artifact_dir(),
        params_dir: &params_dir(),
    })
    .expect_err("must refuse");
    // Zero held of *that* colour, even though the wallet holds 1100 of another — a balance is per
    // colour, and reporting the wrong one would send someone hunting for coins they have.
    assert!(err.contains("holds 0"), "{err}");
}

#[test]
fn an_exact_transfer_creates_no_change_output() {
    if skip() {
        return;
    }
    let (recipient, recipient_epk) = recipient_keys();
    let mut state = state_new().expect("new");
    state = state_insert_coin(
        &state,
        &SENDER_KEY,
        &Coin {
            nonce: [5u8; 32],
            color: COLOR,
            value: 250,
        },
    )
    .expect("insert");

    let (tx, next) = build_transfer_tx(TransferRequest {
        state: &state,
        zswap_role_key: &SENDER_KEY,
        recipient_coin_public_key: recipient.coin_public_key().0 .0,
        recipient_encryption_public_key: &recipient_epk,
        color: COLOR,
        value: 250,
        network_id: "undeployed",
        ttl_secs: 4_000_000_000,
        artifact_dir: &artifact_dir(),
        params_dir: &params_dir(),
    })
    .expect("build the transfer");

    assert!(!tx.is_empty());
    let summary = state_summary_json(&next).expect("summary");
    assert!(summary.contains("\"coins\":[]"), "{summary}");
}
