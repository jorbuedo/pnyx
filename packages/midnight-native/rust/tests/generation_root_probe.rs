//! Does the chain's own collapsed generation update reproduce the chain's generation root?
//!
//! The question this settles: a self-funded spend proves against our DUST tree roots, and the node
//! checks them with `HistoricMerkleTree_check_root` — a root the chain never had can never verify. The
//! device's generation root diverges while its commitment root matches, and generation leaves are the
//! mutable ones (a dtime update *replaces* a leaf) where commitments are append-only. So the suspicion
//! is that the collapsed ranges we take from the indexer no longer describe the tree the chain has.
//!
//! This isolates that from anything the wallet does: a blank state, one collapsed update straight from
//! the indexer, and the root compared against `block(offset:{height}).dustGenerationMerkleTreeRoot` for
//! the block whose `dustGenerationEndIndex` is one past the update's end.
//!
//! ⚠️ **Nothing of ours is inserted.** If this matches, the indexer's collapsed data is sound and the
//! divergence is in our own inserted leaves. If it differs, the collapsed data itself cannot rebuild
//! the chain's tree and no amount of leaf-level correctness would help.
//!
//! `GEN_UPDATE_HEX=<file> GEN_ROOT=<64-hex> cargo test --release --features proving --test generation_root_probe -- --nocapture`

#![cfg(feature = "proving")]

use midnight_ledger::structure::INITIAL_PARAMETERS;
use midnight_native::state_read::DB;

#[test]
fn the_chains_collapsed_update_reproduces_the_chains_generation_root() {
    let (Ok(update_path), Ok(expected_root)) =
        (std::env::var("GEN_UPDATE_HEX"), std::env::var("GEN_ROOT"))
    else {
        eprintln!("SKIP: set GEN_UPDATE_HEX and GEN_ROOT to run this");
        return;
    };
    let hex_text = std::fs::read_to_string(&update_path).expect("read the update hex");
    let blob = hex::decode(hex_text.trim()).expect("the update is hex");

    let state = midnight_ledger::dust::DustLocalState::<DB>::new(INITIAL_PARAMETERS.dust);
    let update: midnight_transient_crypto::merkle_tree::MerkleTreeCollapsedUpdate =
        midnight_serialize::tagged_deserialize(&mut &blob[..])
            .expect("deserialize the collapsed update");
    let state = state
        .apply_generation_collapsed_update(&update)
        .expect("the chain's own update must apply to a blank tree");

    let root = state
        .generating_tree
        .root()
        .expect("a collapsed tree has a root");
    let mut ours = Vec::new();
    midnight_serialize::Serializable::serialize(&root, &mut ours).expect("serialize the root");
    let ours_hex: String = ours.iter().map(|b| format!("{b:02x}")).collect();

    println!("ours   {ours_hex}");
    println!("chain  {expected_root}");
    assert!(
        ours_hex.ends_with(&expected_root)
            || expected_root.ends_with(&ours_hex)
            || ours_hex == expected_root,
        "the chain's own collapsed update does not reproduce the chain's generation root"
    );
}
