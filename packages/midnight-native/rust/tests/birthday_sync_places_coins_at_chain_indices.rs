//! Does a sync that starts at a **birthday height** put coins at the indices the chain gave them?
//!
//! A phone cannot walk Midnight from genesis, so a first sync starts at a recorded height (plan item
//! 61(a)). On its own that is not enough: the commitment tree is indexed by position, so a wallet
//! that applies its first transaction to a blank tree puts the coin at index 0 and every spend it
//! proves is against a root the chain has never held. That is the exact reason the on-device
//! shielded call built in item 60(c) is not submittable.
//!
//! The missing half is the indexer's `zswapMerkleTreeCollapsedUpdate(startIndex, endIndex)`: it
//! fast-forwards the tree across the leaves before the birthday without downloading them. ⚠️ It does
//! **not** validate its own contents — see the third test — so the root is the only evidence the
//! result is the chain's tree.
//!
//! Both fixtures are real preprod data, read off the chain and not simulated:
//!
//! - `mint_shielded_preprod.tx` — `bench/test-shielded-token`'s `mintShielded`, 1,000,000 to the
//!   abandon×12 wallet, in block 2,534,136. The indexer reports it at `zswapStartIndex` **21371**,
//!   `zswapEndIndex` 21372.
//! - `zswap_collapsed_0_21370_preprod.bin` — the collapsed update over `[0, 21370]`, i.e. every leaf
//!   before that transaction.

use bip32::{DerivationPath, XPrv};
use bip39::Mnemonic;
use midnight_native::wallet::{
    state_apply_collapsed_update, state_apply_transaction, state_merkle_root, state_new,
    state_summary_json,
};
use std::fs;
use std::path::PathBuf;

const MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/// The first leaf the mint transaction wrote, per the indexer's `zswapStartIndex` for it.
const MINT_START_INDEX: u64 = 21371;

/// The tree root the chain held after that transaction, per the indexer's `zswapMerkleTreeRoot` for
/// it. **This is the assertion that means something**: an index can be right while the hashes under
/// it are wrong, and only the root catches that.
const MINT_MERKLE_ROOT: &str =
    "73bef2a625f5179e3b4b6d3706732425bc7ae3f0f43de7d5a75b70581a2299174d";

fn zswap_role_key() -> [u8; 32] {
    let seed = Mnemonic::parse(MNEMONIC).expect("parse mnemonic").to_seed("");
    let path: DerivationPath = "m/44'/2400'/0'/3/0".parse().expect("parse path");
    let xprv = XPrv::derive_from_path(seed, &path).expect("derive");
    xprv.private_key().to_bytes().into()
}

fn fixture(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name);
    fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

/// ⚠️ **The assertion the whole item turns on.** Collapse to the birthday first, and the coin lands
/// where the chain put it.
#[test]
fn a_collapsed_update_to_the_birthday_puts_the_coin_at_its_chain_index() {
    let key = zswap_role_key();
    let state = state_new().expect("new state");
    let state = state_apply_collapsed_update(
        &state,
        &fixture("zswap_collapsed_0_21370_preprod.bin"),
    )
    .expect("apply the collapsed update over the leaves before the birthday");

    let after = state_apply_transaction(&state, &key, &fixture("mint_shielded_preprod.tx"), None)
        .expect("apply the mint transaction");
    let summary = state_summary_json(&after).expect("summary");

    eprintln!("after collapse + mint: {summary}");

    assert!(
        summary.contains("\"value\":\"1000000\""),
        "the minted coin was not claimed: {summary}"
    );
    assert!(
        summary.contains(&format!("\"mtIndex\":{MINT_START_INDEX}")),
        "the coin is not at the index the chain gave it ({MINT_START_INDEX}): {summary}"
    );

    let root = state_merkle_root(&after).expect("merkle root");
    assert_eq!(
        root, MINT_MERKLE_ROOT,
        "the local tree is not the chain's after collapsing to the birthday"
    );
}

/// The control, and the reason this test exists: **without** the collapsed update the same scan
/// claims the same coin at index 0. A wallet in that state believes it holds the money and cannot
/// spend it, because every proof it builds is against a root no block ever had.
#[test]
fn without_the_collapsed_update_the_same_coin_lands_at_index_zero() {
    let key = zswap_role_key();
    let after = state_apply_transaction(
        &state_new().expect("new"),
        &key,
        &fixture("mint_shielded_preprod.tx"),
        None,
    )
    .expect("apply");
    let summary = state_summary_json(&after).expect("summary");
    assert!(
        summary.contains("\"mtIndex\":0"),
        "expected the un-collapsed tree to place the coin at 0: {summary}"
    );
}

/// ⚠️ **A collapsed update is not self-validating, and two docs in this repo said it was.**
///
/// This test was written to confirm the claim and refuted it instead: flip any single byte of the
/// 377 and **311 of them are accepted**, each producing a tree that differs from the chain's while
/// looking perfectly healthy. Only the tag and the per-entry framing are checked; the hashes are
/// taken on trust. A wallet in that state reports the right balance and cannot spend a penny of it.
///
/// So the check has to come from outside the update — the root, above. This test pins the real
/// behaviour so nobody re-derives the comfortable version of it from the function's signature.
#[test]
fn a_collapsed_update_does_not_validate_its_own_contents() {
    let base = fixture("zswap_collapsed_0_21370_preprod.bin");
    let blank = state_new().expect("new");

    let accepted = (0..base.len())
        .filter(|i| {
            let mut u = base.clone();
            u[*i] ^= 0xff;
            state_apply_collapsed_update(&blank, &u).is_ok()
        })
        .count();

    assert!(
        accepted > base.len() / 2,
        "expected most byte flips to sail through a check that does not exist; {accepted} of {} did",
        base.len()
    );

    // And a wrong-but-accepted update gives a wrong root, which is what makes the root check the
    // real defence rather than a formality.
    let mut tampered = base.clone();
    tampered[base.len() - 1] ^= 0xff;
    let honest = state_apply_collapsed_update(&blank, &base).expect("honest update");
    let wrong = state_apply_collapsed_update(&blank, &tampered).expect("tampered update accepted");
    assert_ne!(
        state_merkle_root(&honest).expect("root"),
        state_merkle_root(&wrong).expect("root"),
        "a tampered update produced the same root, so the root check would not catch it"
    );
}

/// The whole shape of a birthday sync, over 34 real preprod blocks: collapse to the birthday, then
/// apply every confirmed transaction in order, then check the tree is the chain's.
///
/// The range is chosen for what it contains rather than its length — the mint at 2,534,136, a
/// **partial success** at 2,534,156 whose failed segment must not be applied, and two leaves at
/// 2,534,169 that belong to a stranger and must still advance the tree. Blocks with no transactions
/// are omitted from the fixture because they change nothing; the final root is the chain's for
/// 2,534,169.
#[test]
fn a_birthday_walk_ends_on_the_chains_own_root() {
    let raw = fixture("zswap_walk_preprod_2534136_2534169.json");
    let blocks: serde_json::Value =
        serde_json::from_slice(&raw).expect("parse the walk fixture");
    let blocks = blocks.as_array().expect("an array of blocks");

    let key = zswap_role_key();
    let mut state = state_apply_collapsed_update(
        &state_new().expect("new state"),
        &fixture("zswap_collapsed_0_21370_preprod.bin"),
    )
    .expect("collapse to the birthday");

    for block in blocks {
        for tx in block["txs"].as_array().expect("txs") {
            let bytes = decode_hex(tx["raw"].as_str().expect("raw hex"));
            let segments: Option<Vec<u16>> = tx["segments"].as_array().map(|ids| {
                ids.iter()
                    .map(|id| u16::try_from(id.as_u64().expect("segment id")).expect("segment fits"))
                    .collect()
            });
            state = state_apply_transaction(&state, &key, &bytes, segments.as_deref())
                .expect("apply a confirmed transaction");
        }
    }

    let last = blocks.last().expect("at least one block");
    assert_eq!(
        state_merkle_root(&state).expect("merkle root"),
        last["root"].as_str().expect("root"),
        "after walking to {}, the local tree is not the chain's",
        last["height"]
    );

    // And the coin is still where the chain put it after 33 further blocks of other people's
    // commitments — the property a spend proof actually depends on.
    let summary = state_summary_json(&state).expect("summary");
    assert!(
        summary.contains(&format!("\"mtIndex\":{MINT_START_INDEX}")),
        "the coin moved during the walk: {summary}"
    );
}

fn decode_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}
