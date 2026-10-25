//! Reading a circle's membership tree off its contract state.
//!
//! **A vote needs a member path, and this is where it comes from.** `proposal.compact` seals the
//! electorate's root at creation and holds no tree of its own, so a voter must supply a path whose root
//! equals that sealed value. The contract's own comment says the digests may come from anywhere —
//! reconstructing the tree and comparing against the root *is* the verification — and the cheapest
//! honest source is the circle's own state as the chain holds it.
//!
//! ⚠️ **As of the sealed root, not as of now.** A join after the proposal was created moves the root, so
//! a path read from the *current* state fails the comparison. The caller fetches the state at the
//! proposal's own height (the indexer serves historic contract state) and this reads whatever it is
//! given — which is why nothing here knows about heights or proposals.
//!
//! This replaces the client-side members mirror the plan called for: no local tree, no transcript
//! replay, no per-circle cache to keep coherent. The member ceiling it was also meant to lift is a
//! question about *this* parse rather than about a JS one — the whole-state deserializer that capped a
//! circle at a few hundred members was the generated JS decoder, not this.

use midnight_base_crypto::fab::AlignedValue;
use midnight_base_crypto::hash::HashOutput;
use midnight_onchain_runtime::state::{ContractState, StateValue};
use midnight_transient_crypto::fab::ValueReprAlignedValue;
use midnight_transient_crypto::merkle_tree::leaf_hash;

use crate::state_read::{field, DB};

/// `members` in `circle.compact`'s ledger order: 0 circleId, 1 isOpen, 2 members, 3 moderators.
///
/// Positional, like every slot constant here — a ledger field added above this moves it, and the
/// failure is a path read from the *moderators* tree, which is a valid path to the wrong root.
pub const MEMBERS_SLOT: u8 = 2;
/// `moderators`, in the same ledger order. Its own constant rather than `MEMBERS_SLOT + 1`: the trees
/// are different heights (20 vs 10), and a path read from the wrong one is a **valid path to a wrong
/// root** — it fails as "not a moderator" rather than as a misread.
pub const MODERATORS_SLOT: u8 = 3;
/// A `HistoricMerkleTree` is three fields: the tree, the insertion counter, and the root history.
const TREE_IN_HISTORIC: usize = 0;
/// `inviteAuthority`, appended last in `circle.compact`'s ledger order and required to stay there.
///
/// ⚠️ Mirrored in `preimage.rs`'s `INVITE_AUTHORITY_IDX` — two hardcoded indices for one ledger slot,
/// which is exactly how `MODERATORS_IDX` shifted 6 → 3 unnoticed once already. Both are pinned against
/// `contract-info.json` by the deploy tests.
pub const INVITE_AUTHORITY_SLOT: u8 = 7;

/// Bytes per path entry on the bridge: a 32-byte little-endian sibling plus one `goes_left` byte.
const ENTRY_BYTES: usize = 33;
/// `HistoricMerkleTree<20, …>`, so every path has exactly this many entries.
pub const MEMBER_PATH_DEPTH: usize = 20;
/// `HistoricMerkleTree<10, …>` for moderators — a shallower tree, and the depth is checked rather than
/// assumed because a short path hashes to a root nothing matches.
pub const MODERATOR_PATH_DEPTH: usize = 10;

/// The member path for `leaf`, encoded as the bridge carries it (20 × 33 bytes).
///
/// `None` would be ambiguous here — "not a member" and "we misread the state" must not look alike — so
/// both are `Err` with distinct messages.
pub fn member_path(state_bytes: &[u8], leaf: [u8; 32]) -> Result<Vec<u8>, String> {
    path_in(
        state_bytes,
        leaf,
        MEMBERS_SLOT,
        MEMBER_PATH_DEPTH,
        "members",
    )
}

/// The moderator path for `leaf`, same encoding — what `requireModerator` proves against.
pub fn moderator_path(state_bytes: &[u8], leaf: [u8; 32]) -> Result<Vec<u8>, String> {
    path_in(
        state_bytes,
        leaf,
        MODERATORS_SLOT,
        MODERATOR_PATH_DEPTH,
        "moderators",
    )
}

fn path_in(
    state_bytes: &[u8],
    leaf: [u8; 32],
    slot: u8,
    depth: usize,
    what: &str,
) -> Result<Vec<u8>, String> {
    let state: ContractState<DB> = midnight_serialize::tagged_deserialize(&mut &state_bytes[..])
        .map_err(|e| format!("deserialize circle contract state: {e}"))?;
    let StateValue::Array(ref historic) = field(&state, slot as usize)? else {
        return Err(format!(
            "ledger field {slot} ({what}) is not a historic merkle tree"
        ));
    };
    let tree = historic
        .get(TREE_IN_HISTORIC)
        .ok_or_else(|| format!("the {what} field holds no tree"))?;
    let StateValue::BoundedMerkleTree(ref tree) = *tree else {
        return Err(format!(
            "the {what} field's first entry is not a merkle tree"
        ));
    };
    // The tree stores `leaf_hash` of the aligned `Bytes<32>`, exactly as the `join` circuit's transcript
    // inserts it — so the same construction has to be used to find it (`preimage.rs` builds the other
    // half of this pair).
    let hashed = leaf_hash(&ValueReprAlignedValue(AlignedValue::from(HashOutput(leaf))));
    let path = tree
        .find_path_for_hashed_leaf_within_range(hashed, ..)
        .ok_or_else(|| format!("this persona is not in the {what} tree"))?;
    if path.path.len() != depth {
        return Err(format!(
            "a {what} path has {depth} entries, this tree gave {}",
            path.path.len()
        ));
    }
    let mut out = vec![0u8; depth * ENTRY_BYTES];
    for (i, entry) in path.path.iter().enumerate() {
        let sibling = entry.sibling.0.as_le_bytes();
        out[i * ENTRY_BYTES..i * ENTRY_BYTES + sibling.len()].copy_from_slice(&sibling);
        out[i * ENTRY_BYTES + 32] = u8::from(entry.goes_left);
    }
    Ok(out)
}

/// The root the tree currently holds, little-endian — what a client compares against a proposal's
/// sealed `membersRoot` before it bothers proving anything.
pub fn members_root(state_bytes: &[u8]) -> Result<[u8; 32], String> {
    let state: ContractState<DB> = midnight_serialize::tagged_deserialize(&mut &state_bytes[..])
        .map_err(|e| format!("deserialize circle contract state: {e}"))?;
    let StateValue::Array(ref historic) = field(&state, MEMBERS_SLOT as usize)? else {
        return Err(format!(
            "ledger field {MEMBERS_SLOT} (members) is not a historic merkle tree"
        ));
    };
    let tree = historic
        .get(TREE_IN_HISTORIC)
        .ok_or_else(|| "the members field holds no tree".to_string())?;
    let StateValue::BoundedMerkleTree(ref tree) = *tree else {
        return Err("the members field's first entry is not a merkle tree".to_string());
    };
    let root = tree
        .root()
        .ok_or_else(|| "the members tree has no root".to_string())?;
    let le = root.0.as_le_bytes();
    le.try_into()
        .map_err(|_| "a field element did not fit in 32 bytes".to_string())
}

/// A circle's `inviteAuthority` cell — the commitment its delegated invite issuer proves knowledge of.
///
/// `None` means the circle has delegated to nobody, which is a *different fact* from a state we could
/// not read and must never collapse into it: a UI that showed "not delegated" for an unreadable state
/// would tell a founder to re-delegate an authority that is already live.
///
/// ⚠️ **An unassigned `Bytes<32>` cell is an empty atom, not 32 zero bytes.** Trailing zeros are
/// dropped by the serialization, so a never-delegated circle's cell decodes as an absent atom rather
/// than as zeros — and `circle.compact`'s own zero check treats both as "nobody". Reading this as an
/// error would make every un-delegated circle look broken.
pub fn invite_authority(state_bytes: &[u8]) -> Result<Option<[u8; 32]>, String> {
    let state: ContractState<DB> = midnight_serialize::tagged_deserialize(&mut &state_bytes[..])
        .map_err(|e| format!("deserialize circle contract state: {e}"))?;
    // ⚠️ **The field must exist; only the *atom* may be absent.** Falling back for both — which is
    // what `preimage.rs` does, where a wrong contract cannot get this far — made an identity contract
    // read as "delegated to nobody" instead of as an error. A UI would then have offered a founder a
    // delegation control for a contract that is not a circle at all.
    let cell = crate::state_read::field(&state, INVITE_AUTHORITY_SLOT as usize)?;
    let StateValue::Cell(ref c) = cell else {
        return Err(format!(
            "ledger field {INVITE_AUTHORITY_SLOT} (inviteAuthority) is not a cell"
        ));
    };
    // An unassigned `Bytes<32>` drops its trailing zeros, so a never-delegated circle's cell holds
    // an empty atom — or no atom at all. Both are "nobody", and neither is a misread.
    let atom = c.value.0.first().map(|a| a.0.clone()).unwrap_or_default();
    let authority = crate::state_read::bytes32(&atom, "inviteAuthority")?;
    Ok(if authority == [0u8; 32] {
        None
    } else {
        Some(authority)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hand-rolled rather than via serde: the crate has no JSON dependency and the integration tests
    /// read these fixtures the same way (`tests/build_vote_preimages.rs`).
    fn json_field(key: &str) -> String {
        let json = include_str!("../fixtures/vote.inputs.json");
        let needle = format!("\"{key}\"");
        let start = json
            .find(&needle)
            .and_then(|i| json[i..].find(':').map(|j| i + j + 1))
            .expect("key present");
        let rest = json[start..].trim_start();
        match rest.strip_prefix('"') {
            Some(quoted) => quoted[..quoted.find('"').expect("closing quote")].to_string(),
            None => rest[..rest.find([',', '\n', '}']).expect("delimiter")]
                .trim()
                .to_string(),
        }
    }

    fn json_bytes(key: &str) -> Vec<u8> {
        hex::decode(json_field(key)).expect("hex")
    }

    const STATE: &[u8] = include_bytes!("../fixtures/circle_populated.contract_state");

    /// The oracle is the JS witness provider: `dump-vote-preimages.mts` reads the path out of the same
    /// populated circle with `members.findPathForLeaf` and writes it into `vote.inputs.json`. If these
    /// two disagree, the path a device proves with is not the path the circuit expects — and the only
    /// symptom would be a refused vote with the proof stage blamed.
    #[test]
    fn the_path_matches_the_one_the_js_witness_produces() {
        let leaf: [u8; 32] = json_bytes("voterLeaf").try_into().expect("32 bytes");
        assert_eq!(
            member_path(STATE, leaf).expect("path"),
            json_bytes("memberPath")
        );
    }

    /// Three members, so the path carries real siblings rather than blanks in every slot — a
    /// single-leaf tree hides left/right mistakes in both the encoder and this reader.
    #[test]
    fn the_populated_fixture_actually_has_siblings() {
        let leaf: [u8; 32] = json_bytes("voterLeaf").try_into().expect("32 bytes");
        let path = member_path(STATE, leaf).expect("path");
        let entries_with_a_sibling = (0..MEMBER_PATH_DEPTH)
            .filter(|i| {
                path[i * ENTRY_BYTES..i * ENTRY_BYTES + 32]
                    .iter()
                    .any(|b| *b != 0)
            })
            .count();
        assert!(
            entries_with_a_sibling > 0,
            "every sibling was blank, so the tree held one leaf"
        );
    }

    #[test]
    fn a_persona_that_never_joined_is_refused_rather_than_given_a_blank_path() {
        let error = member_path(STATE, [0x99; 32]).expect_err("a stranger has no path");
        assert!(error.contains("not in the members tree"), "{error}");
    }

    /// What a client checks before it proves anything: the root it can read here is the root the
    /// proposal sealed.
    #[test]
    fn the_root_read_here_is_the_one_the_proposal_sealed() {
        assert_eq!(
            members_root(STATE).expect("root").to_vec(),
            json_bytes("membersRootLe")
        );
    }

    /// The populated fixture delegated to `inviteAuthoritySk`, so the cell has to read back as its
    /// commitment — the same value `build_issue_invite_proven_tx` compares against before proving.
    #[test]
    fn the_invite_authority_is_the_commitment_the_fixture_delegated_to() {
        let sk: [u8; 32] = json_bytes("inviteAuthoritySk").try_into().expect("32 bytes");
        let expected = crate::preimage::invite_authority_commitment(sk).0;
        assert_eq!(invite_authority(STATE).expect("read"), Some(expected));
    }

    /// ⚠️ The case that is easy to get wrong: a circle that never delegated has an **empty atom**, not
    /// 32 zero bytes — trailing zeros are dropped by the serialization. Read as an error, every
    /// un-delegated circle would look broken; read as zeros, `bytes32` still yields zeros and this is
    /// what turns them back into "nobody".
    #[test]
    fn a_circle_that_delegated_to_nobody_reads_as_nobody_rather_than_as_an_error() {
        let fresh = include_bytes!("../fixtures/circle_deploy.contract_state");
        assert_eq!(invite_authority(fresh).expect("read"), None);
    }

    /// "Nobody" and "we could not read it" must never collapse: a UI that showed the first for the
    /// second would tell a founder to redo a delegation that is already live.
    #[test]
    fn a_state_that_is_not_a_circle_is_an_error_not_nobody() {
        let identity = include_bytes!("../fixtures/identity_row_published.contract_state");
        assert!(invite_authority(identity).is_err());
    }

    /// Not a merkle tree at all — the shape check has to fail loudly rather than read whatever is
    /// there, because the neighbouring slot is the *moderators* tree and a path from it is a valid
    /// path to the wrong root.
    #[test]
    fn a_state_that_is_not_a_circle_is_refused() {
        let identity = include_bytes!("../fixtures/identity_row_published.contract_state");
        assert!(member_path(identity, [0x11; 32]).is_err());
    }
}
