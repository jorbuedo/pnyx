//! Rebuild this wallet's DUST generation tree from the **chain's own** data, and compare its root.
//!
//! The wallet's generation root diverges from the chain while its commitment root matches, which
//! refuses every self-funded spend as `Custom error: 170` (`InvalidDustSpendProof`) — the spend circuit
//! checks both roots with `HistoricMerkleTree_check_root`, and a root the chain never had can never
//! verify.
//!
//! A companion probe already showed the indexer's collapsed update reproduces the chain's root exactly
//! on a blank tree, so the collapsed data is sound. That leaves the wallet's own inserted leaves. This
//! replays the wallet's exact algorithm — collapse each gap, insert each owned entry, then apply the
//! chain's dtime evidence — but takes **every field from the indexer**, including the `owner` the app
//! never requests and derives from its key instead.
//!
//! So the two outcomes are both answers:
//! - root **matches** → our construction of a leaf is wrong, and `owner` is the field the app supplies
//!   itself.
//! - root **differs** → the fields are right and the fault is in the algorithm, not the leaf.
//!
//! `PLAN=<build-plan.txt> GEN_ROOT=<hex> cargo test --release --features proving --test generation_tree_replay -- --nocapture`

#![cfg(feature = "proving")]

use midnight_base_crypto::hash::HashOutput;
use midnight_base_crypto::time::Timestamp;
use midnight_ledger::dust::{DustGenerationInfo, DustLocalState, DustPublicKey, InitialNonce};
use midnight_ledger::structure::INITIAL_PARAMETERS;
use midnight_native::state_read::DB;
use midnight_serialize::{tagged_deserialize, Deserializable, Serializable};
use midnight_transient_crypto::merkle_tree::{MerkleTreeCollapsedUpdate, TreeInsertionPath};

fn bytes32(hex_text: &str) -> [u8; 32] {
    let raw = hex::decode(hex_text).expect("hex");
    raw.try_into().expect("32 bytes")
}

#[test]
fn the_wallets_own_build_reproduces_the_chains_generation_root() {
    let (Ok(plan_path), Ok(expected)) = (std::env::var("PLAN"), std::env::var("GEN_ROOT")) else {
        eprintln!("SKIP: set PLAN and GEN_ROOT to run this");
        return;
    };
    let plan = std::fs::read_to_string(&plan_path).expect("read the plan");

    let mut state = DustLocalState::<DB>::new(INITIAL_PARAMETERS.dust);
    let (mut collapses, mut inserts, mut evidence) = (0usize, 0usize, 0usize);

    for line in plan.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.first().copied() {
            Some("C") => {
                let blob = hex::decode(parts[3]).expect("hex");
                let update: MerkleTreeCollapsedUpdate =
                    tagged_deserialize(&mut &blob[..]).expect("collapsed update");
                state = state
                    .apply_generation_collapsed_update(&update)
                    .expect("apply collapse");
                collapses += 1;
            }
            Some("E") => {
                let index: u64 = parts[1].parse().expect("index");
                // ⚠️ The chain's own owner, not one derived from a key. That is the one field the app
                // supplies itself, so taking the chain's here is what makes this test discriminating.
                // ⚠️ 33 bytes, not 32. An `Fr` serializes with a leading marker byte, so the indexer's
                // `owner` is the plain `Serializable` form — reading it as raw field bytes is off by one
                // and yields a different key entirely.
                let owner_bytes = hex::decode(parts[3]).expect("hex");
                let owner: DustPublicKey =
                    Deserializable::deserialize(&mut &owner_bytes[..], 0).expect("owner");
                let backing = InitialNonce(HashOutput(bytes32(parts[7])));
                let value: u128 = parts[4].parse().expect("value");
                state = state
                    .insert_generation_info(
                        index,
                        DustGenerationInfo {
                            value,
                            owner,
                            nonce: backing,
                            dtime: Timestamp::MAX,
                        },
                        Some(backing),
                    )
                    .expect("insert generation info");
                inserts += 1;
            }
            Some("D") => {
                let blob = hex::decode(parts[3]).expect("hex");
                let insertion: TreeInsertionPath<DustGenerationInfo> =
                    tagged_deserialize(&mut &blob[..]).expect("insertion path");
                state.generating_tree = state
                    .generating_tree
                    .update_from_evidence(insertion)
                    .expect("dtime evidence");
                evidence += 1;
            }
            _ => {}
        }
    }

    // The wallet collapses forward to the tip before reading roots, and so must this: a tree still
    // holding witness data for ranges it does not need has no computable root.
    let end: u64 = std::env::var("PLAN_END")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(383_159);
    let state = state
        .collapse_generation_tree(0, end)
        .expect("collapse forward");
    let root = state.generating_tree.root().expect("a root");
    let mut ours = Vec::new();
    Serializable::serialize(&root, &mut ours).expect("serialize");
    let ours_hex: String = ours.iter().map(|b| format!("{b:02x}")).collect();
    println!("collapses {collapses}, inserts {inserts}, evidence {evidence}");
    println!("ours   {ours_hex}");
    println!("chain  {expected}");
    assert_eq!(
        ours_hex, expected,
        "the wallet's own build must reproduce the chain's generation root"
    );
}
