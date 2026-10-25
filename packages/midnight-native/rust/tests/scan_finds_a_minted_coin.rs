//! Can a wallet **find a contract-minted shielded coin by scanning**, with nothing but its seed?
//!
//! This settles a question the rest of the tree answers inconsistently. `payment.compact` and
//! `wallet.rs::state_insert_coin` both say a contract-initiated mint or send "creates no output
//! ciphertext, so scanning cannot discover it" — and that claim decides whether the shielded coin
//! store is a rebuildable cache or irreplaceable custody.
//!
//! The fixture is a **real preprod transaction**: `bench/test-shielded-token`'s `mintShielded`
//! minting 1,000,000 to the abandon×12 wallet's own coin public key, in block 2,534,136
//! (`00a7ce0cea7cc3e3a37dc660ab9c767c928832c765ccb8d8c843f6849d9ef8cf70`). Nothing is simulated: if
//! this wallet can claim that coin from the transaction alone, a fresh device with the same mnemonic
//! can too.

use bip32::{DerivationPath, XPrv};
use bip39::Mnemonic;
use midnight_native::wallet::{state_apply_transaction, state_new, state_summary_json};
use std::fs;
use std::path::PathBuf;

/// The canonical test wallet. Its shielded coin public key is `238d8504…`, which is the recipient
/// the mint named.
const MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/// Role 3 is Zswap — role 2 is Dust, and the published SDK guide had that wrong until
/// `midnightntwrk/midnight-docs#1248`.
fn zswap_role_key() -> [u8; 32] {
    let seed = Mnemonic::parse(MNEMONIC).expect("parse mnemonic").to_seed("");
    let path: DerivationPath = "m/44'/2400'/0'/3/0".parse().expect("parse path");
    let xprv = XPrv::derive_from_path(seed, &path).expect("derive");
    xprv.private_key().to_bytes().into()
}

fn fixture() -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/mint_shielded_preprod.tx");
    fs::read(p).expect("read mint_shielded_preprod.tx")
}

#[test]
fn a_contract_minted_coin_is_found_by_scanning_with_only_the_seed() {
    let key = zswap_role_key();
    let blank = state_new().expect("new state");

    // `None` = every section: the transaction succeeded entirely, which is what the indexer reports
    // by having nothing per-segment to report.
    let after = state_apply_transaction(&blank, &key, &fixture(), None)
        .expect("apply the mint transaction");
    let summary = state_summary_json(&after).expect("summary");

    eprintln!("after applying the real mint: {summary}");

    // ⚠️ **The claim under test.** If this fails, the repo's "a contract mint creates no ciphertext,
    // so scanning cannot discover it" is right and the coin store is custody. If it passes, the
    // coin is as recoverable as any other and the claim needs correcting where it appears.
    assert!(
        summary.contains("\"value\":\"1000000\""),
        "the minted coin was not claimed by a scan that had only the seed: {summary}"
    );
    // The colour is `tokenType(pad(32,\"pnyx:test-coin\"), 314efe0e…)` — read off the mint, not
    // recomputed here, so a changed domain separator fails loudly rather than silently matching.
    assert!(
        summary.contains("1d492ad57ef8b610a6b188b5a88c2abfbc689a27ca6556b480dfa6d1df827519"),
        "claimed a coin, but not the one the mint created: {summary}"
    );
}

/// The same transaction, under a different seed, must yield nothing — otherwise the test above
/// would pass for a wallet that claims every coin it sees, which is not a wallet.
#[test]
fn another_seed_claims_nothing_from_the_same_transaction() {
    let stranger = {
        let seed = Mnemonic::parse(
            "legal winner thank year wave sausage worth useful legal winner thank yellow",
        )
        .expect("parse mnemonic")
        .to_seed("");
        let path: DerivationPath = "m/44'/2400'/0'/3/0".parse().expect("parse path");
        XPrv::derive_from_path(seed, &path)
            .expect("derive")
            .private_key()
            .to_bytes()
            .into()
    };
    let after = state_apply_transaction(&state_new().expect("new"), &stranger, &fixture(), None)
        .expect("apply");
    let summary = state_summary_json(&after).expect("summary");
    assert!(
        summary.contains("\"coins\":[]"),
        "a stranger must claim nothing: {summary}"
    );
}
