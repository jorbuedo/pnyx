//! Which generation leaf does this device disagree with the chain about?
//!
//! The device's DUST generation root differs from the chain's while its commitment root matches, and
//! that refuses every self-funded spend as `Custom error: 170` — the spend circuit checks both roots
//! with `HistoricMerkleTree_check_root`, so a root the chain never had can never verify.
//!
//! `generation_tree_replay.rs` established that the wallet's *algorithm and inputs* are right: replayed
//! against the indexer's own data it reproduces a genuine chain root. So the disagreement is between
//! **this device's persisted state** and that reconstruction, and this names the leaf.
//!
//! Both sides are read the same way — `generating_tree.index(i)` — so a difference is a difference in
//! the leaf, not in how it was fetched. Leaves the device has collapsed away read as absent on one side
//! and are reported as such rather than counted as agreement.
//!
//! `STATE=<dust-state.hex> PLAN=<build-plan.txt> cargo test --release --features proving --test generation_tree_diff -- --nocapture`

#![cfg(feature = "proving")]

use midnight_base_crypto::hash::HashOutput;
use midnight_base_crypto::time::Timestamp;
use midnight_ledger::dust::{DustGenerationInfo, DustLocalState, DustPublicKey, InitialNonce};
use midnight_ledger::structure::INITIAL_PARAMETERS;
use midnight_native::state_read::DB;
use midnight_serialize::{tagged_deserialize, Deserializable};
use midnight_transient_crypto::merkle_tree::{MerkleTreeCollapsedUpdate, TreeInsertionPath};

fn bytes32(hex_text: &str) -> [u8; 32] {
    hex::decode(hex_text)
        .expect("hex")
        .try_into()
        .expect("32 bytes")
}

/// The reconstruction that reproduces a chain root, from the indexer's own feed.
fn replay(plan: &str) -> DustLocalState<DB> {
    let mut state = DustLocalState::<DB>::new(INITIAL_PARAMETERS.dust);
    for line in plan.lines() {
        let p: Vec<&str> = line.split_whitespace().collect();
        match p.first().copied() {
            Some("C") => {
                let blob = hex::decode(p[3]).expect("hex");
                let update: MerkleTreeCollapsedUpdate =
                    tagged_deserialize(&mut &blob[..]).expect("update");
                state = state
                    .apply_generation_collapsed_update(&update)
                    .expect("collapse");
            }
            Some("E") => {
                let owner_bytes = hex::decode(p[3]).expect("hex");
                let owner: DustPublicKey =
                    Deserializable::deserialize(&mut &owner_bytes[..], 0).expect("owner");
                let backing = InitialNonce(HashOutput(bytes32(p[7])));
                state = state
                    .insert_generation_info(
                        p[1].parse().expect("index"),
                        DustGenerationInfo {
                            value: p[4].parse().expect("value"),
                            owner,
                            nonce: backing,
                            dtime: Timestamp::MAX,
                        },
                        Some(backing),
                    )
                    .expect("insert");
            }
            Some("D") => {
                let blob = hex::decode(p[3]).expect("hex");
                let insertion: TreeInsertionPath<DustGenerationInfo> =
                    tagged_deserialize(&mut &blob[..]).expect("insertion path");
                state.generating_tree = state
                    .generating_tree
                    .update_from_evidence(insertion)
                    .expect("evidence");
            }
            _ => {}
        }
    }
    state
}

#[test]
fn every_generation_leaf_this_device_holds_matches_the_chains() {
    let (Ok(state_path), Ok(plan_path)) = (std::env::var("STATE"), std::env::var("PLAN")) else {
        eprintln!("SKIP: set STATE and PLAN to run this");
        return;
    };
    let raw = hex::decode(
        std::fs::read_to_string(&state_path)
            .expect("read state")
            .trim(),
    )
    .expect("hex");
    let device: DustLocalState<DB> = tagged_deserialize(&mut &raw[..]).expect("a dust local state");
    let plan = std::fs::read_to_string(&plan_path).expect("read plan");
    let theirs = replay(&plan);

    let indices: Vec<u64> = plan
        .lines()
        .filter(|l| l.starts_with("E "))
        .map(|l| {
            l.split_whitespace()
                .nth(1)
                .expect("index")
                .parse()
                .expect("u64")
        })
        .collect();

    // Printed so the caller can ask the chain whether this root ever existed. A root that matches some
    // historic block is a *stale* state, which the spend circuit accepts; one that matches none was
    // never the chain's and can never verify.
    for (name, tree) in [
        ("device", &device.generating_tree),
        ("replay", &theirs.generating_tree),
    ] {
        match tree.root() {
            Some(root) => {
                let mut out = Vec::new();
                midnight_serialize::Serializable::serialize(&root, &mut out).expect("serialize");
                let hexed: String = out.iter().map(|b| format!("{b:02x}")).collect();
                println!("{name} generation root {hexed}");
            }
            None => {
                println!("{name} generation root: not computable (tree still holds witness data)")
            }
        }
    }

    // ⚠️ **Leaves right, root wrong is the signature of a stale internal hash**, not of bad data. The
    // ledger's own `replay_events` ends with `generating_tree.rehash()`; `dust:applyDtimeUpdate` calls
    // `update_from_evidence` and encodes without one. If rehashing this device's tree turns its root
    // into a root the chain actually had, that missing rehash is the whole defect.
    // The probe strips the tag by slicing a fixed 64 hex characters. Measured here rather than
    // assumed: a tag of any other length would misalign every comparison it makes.
    {
        let digest = device
            .generating_tree
            .clone()
            .rehash()
            .root()
            .expect("root");
        let mut tagged = Vec::new();
        midnight_serialize::tagged_serialize(&digest, &mut tagged).expect("tagged");
        let mut plain = Vec::new();
        midnight_serialize::Serializable::serialize(&digest, &mut plain).expect("plain");
        println!(
            "tagged {} bytes ({} hex) · payload {} bytes · tag {} bytes ({} hex)",
            tagged.len(),
            tagged.len() * 2,
            plain.len(),
            tagged.len() - plain.len(),
            (tagged.len() - plain.len()) * 2,
        );
        println!(
            "tag text {:?}",
            String::from_utf8_lossy(&tagged[..tagged.len() - plain.len()])
        );
    }

    let rehashed = device.generating_tree.clone().rehash();
    match rehashed.root() {
        Some(root) => {
            let mut out = Vec::new();
            midnight_serialize::Serializable::serialize(&root, &mut out).expect("serialize");
            let hexed: String = out.iter().map(|b| format!("{b:02x}")).collect();
            println!("device generation root AFTER rehash {hexed}");
        }
        None => println!("device generation root after rehash: not computable"),
    }

    let (mut agree, mut absent, mut differ) = (0usize, 0usize, 0usize);
    for i in &indices {
        let ours = device.generating_tree.index(*i).map(|(_, info)| info);
        let chain = theirs.generating_tree.index(*i).map(|(_, info)| info);
        match (ours, chain) {
            (Some(a), Some(b)) => {
                if a.value == b.value
                    && a.owner == b.owner
                    && a.nonce == b.nonce
                    && a.dtime == b.dtime
                {
                    agree += 1;
                } else {
                    differ += 1;
                    if differ <= 8 {
                        println!("index {i} DIFFERS");
                        if a.value != b.value {
                            println!("  value  device {} · chain {}", a.value, b.value);
                        }
                        if a.dtime != b.dtime {
                            println!("  dtime  device {:?} · chain {:?}", a.dtime, b.dtime);
                        }
                        if a.owner != b.owner {
                            println!("  owner  differs");
                        }
                        if a.nonce != b.nonce {
                            println!("  nonce  differs");
                        }
                    }
                }
            }
            _ => absent += 1,
        }
    }
    println!(
        "\n{} leaves compared: {agree} agree, {differ} differ, {absent} absent on one side",
        indices.len()
    );
    assert_eq!(
        differ, 0,
        "the device disagrees with the chain about {differ} generation leaf/leaves"
    );
}
