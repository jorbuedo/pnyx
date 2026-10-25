//! Native construction of a circle's `ContractDeploy` — creating a circle is a **deploy**, not a
//! call (`docs/CONTRACT_TOPOLOGY.md` split 2).
//!
//! **Why this lives on the device rather than in the sponsor.** `ContractDeploy::new` samples its
//! nonce from `OsRng` and the wasm binding exposes no alternative, so an SDK-built deploy has a
//! random address — which means a circle has no canonical address and whoever holds the registry can
//! substitute a contract whose `founder` (and therefore whose moderator seed) is its own. The Rust
//! struct's `nonce` field is public, so building the deploy here lets the address commit to
//! `(circleId, isOpen, founder)` and makes substitution unrepresentable. Full reasoning:
//! `docs/CONTRACT_MIGRATION.md` → "Decided 2026-08-11".
//!
//! **No proving happens here.** A constructor is not a circuit, so a deploy carries no ZK proof —
//! only the initial state and the nonce. That makes this the cheapest path in the whole rail. The
//! sponsor still pays: balancing adds Zswap inputs/outputs to the surrounding `Intent`, never to the
//! `ContractDeploy`, so the address it funds is one it cannot influence.
//!
//! The initial state must reproduce `contract.initialState(...)`, since the address is a hash over
//! it. `circle_deploy.contract_state` (written by `dump-circle-deploy.mts` via the SDK's own deploy
//! path) pins that, and `deploy_state_matches_the_compiled_constructor` is the check.
//!
//! Two things that comparison taught, both easy to get wrong:
//!
//! - **The trees are lazily hashed.** `MerkleTree::root()` returns `None` until `rehash()`, so
//!   recording a root without it silently writes another zero — the historic-roots map collapses to
//!   one entry and every membership proof against the tree fails.
//! - **The SDK installs a *satisfiable* maintenance authority**, sampling a signing key even when
//!   none is passed. Ours is deliberately the unsatisfiable default, so our state differs from the
//!   SDK's in exactly that field — which is why the check compares fields rather than whole bytes.
//!   Serialized bytes also carry the storage arena's rc-map, which varies by construction route
//!   without the state differing.

use midnight_base_crypto::fab::{
    AlignedValue, Alignment, AlignmentAtom, AlignmentSegment, Value, ValueAtom,
};
use midnight_base_crypto::hash::{persistent_hash, HashOutput};
use midnight_coin_structure::contract::ContractAddress;
use midnight_ledger::structure::ContractDeploy;
use midnight_onchain_runtime::state::{
    ChargedState, ContractMaintenanceAuthority, ContractOperation, ContractState, EntryPointBuf,
    StateValue,
};
use midnight_serialize::tagged_deserialize;
use midnight_storage::arena::Sp;
use midnight_storage::storage::{Array, HashMap};
use midnight_storage::DefaultDB;
use midnight_transient_crypto::curve::Fr;
use midnight_transient_crypto::fab::ValueReprAlignedValue;
use midnight_transient_crypto::merkle_tree::MerkleTree;
use midnight_transient_crypto::proofs::VerifierKey;

type DB = DefaultDB;

/// The 7 `export ledger` fields of `circle.compact`, in declaration order.
///
/// Was 11 until the split (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10): `proposals`, `proposalCount`,
/// `actionNullifiers` and `voteCommits` moved to `proposal.compact` — one deploy per proposal — and
/// `spentInvites` was deleted outright, because spending an invite now removes its commitment from
/// `invites` and absence enforces single-use.
/// `moderatorAuth` was appended as field 6 (the moderator auth key the content plane verifies
/// signatures against). Appended **last** on purpose: slots are positional, and inserting one
/// anywhere else renumbers every index in `preimage.rs`.
/// `inviteAuthority` was appended as field 7, for the same positional reason as `moderatorAuth`.
const LEDGER_FIELDS: usize = 8;
/// `members` is a `HistoricMerkleTree<20>`, `moderators` a `HistoricMerkleTree<10>`.
const MEMBERS_HEIGHT: u8 = 20;
const MODERATORS_HEIGHT: u8 = 10;

/// Every circuit `circle.compact` exports. The deploy's `operations` map carries one verifier key
/// per entry point, and all of it feeds the address — so a missing or extra entry is a different
/// contract, not a tolerable difference.
pub const CIRCLE_ENTRY_POINTS: [&str; 7] = [
    "setInvite",
    "issueInvite",
    "setInviteAuthority",
    "addModerator",
    "join",
    "setMember",
    "leaveCircle",
];

/// `proposal.compact`'s two. A proposal is a **deploy**, so `createProposal` is not an entry point
/// anywhere — the id is the content commitment, and two authors never conflict.
pub const PROPOSAL_ENTRY_POINTS: [&str; 2] = ["castVote", "revealVote"];

fn cell(av: AlignedValue) -> StateValue<DB> {
    StateValue::Cell(Sp::new(av))
}

fn empty_map() -> StateValue<DB> {
    StateValue::Map(HashMap::new())
}

/// A `Map<Bytes<32>, Bytes<32>>` holding exactly one pair — what the constructor's
/// `moderatorAuth.insert(founder, founderAuth)` leaves behind.
fn map_of_one(key: [u8; 32], value: [u8; 32]) -> StateValue<DB> {
    let map: HashMap<AlignedValue, StateValue<DB>, DB> = HashMap::new();
    StateValue::Map(map.insert(
        AlignedValue::from(HashOutput(key)),
        cell(AlignedValue::from(HashOutput(value))),
    ))
}

/// A `Set<Bytes<32>>` holding exactly one member — what the constructor's
/// `joinedIdentities.insert(founderJoined)` leaves behind. A Set is a Map to `Null`, the same shape
/// `historic_merkle_tree` uses for its roots map.
fn set_of_one(key: [u8; 32]) -> StateValue<DB> {
    let set: HashMap<AlignedValue, StateValue<DB>, DB> = HashMap::new();
    StateValue::Map(set.insert(AlignedValue::from(HashOutput(key)), StateValue::Null))
}

/// A `Uint<64>` cell holding zero — an **empty** atom, not eight zero bytes. Counters and tallies
/// use this; a fixed-width encoding here would not match what the runtime writes.
fn counter_zero() -> AlignedValue {
    AlignedValue::new(
        Value(vec![ValueAtom(Vec::new())]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: 8,
        })]),
    )
    .expect("an empty u64 atom fits its alignment")
}

fn counter_of(n: u64) -> AlignedValue {
    AlignedValue::new(
        Value(vec![ValueAtom::from(n)]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: 8,
        })]),
    )
    .expect("a u64 atom fits its alignment")
}

/// A `Bytes<32>` cell holding all zeros — the value an unassigned `Bytes<32>` ledger field starts at.
///
/// ⚠️ **An empty atom, not 32 zero bytes.** The encoding drops trailing zeros, so the compact
/// runtime's own constructor output carries an empty atom here; a full-width zero cell is a different
/// state, a different serialization and therefore a different contract address.
fn zero_bytes32_cell() -> AlignedValue {
    AlignedValue::new(
        Value(vec![ValueAtom(Vec::new())]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: 32,
        })]),
    )
    .expect("an empty 32-byte atom fits its alignment")
}

fn bool_cell(b: bool) -> AlignedValue {
    AlignedValue::new(
        Value(vec![ValueAtom::from(b)]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: 1,
        })]),
    )
    .expect("a boolean fits its alignment")
}

/// A `Field` key, as the historic-roots map uses. Zero serializes as an empty atom.
fn field_key(x: Fr) -> AlignedValue {
    AlignedValue::new(
        Value(vec![ValueAtom::from(x)]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Field)]),
    )
    .expect("a field element fits its alignment")
}

/// A `HistoricMerkleTree<height>` ledger field: `[tree, next-index counter, historic-roots map]`.
///
/// The roots map holds **every** root the tree has had, including the blank tree's — which is why a
/// freshly constructed field already has one entry. That is what lets a member prove against a root
/// that has since moved on.
fn historic_merkle_tree(height: u8, leaves: &[HashOutput]) -> Result<StateValue<DB>, String> {
    let mut tree: MerkleTree<(), DB> = MerkleTree::blank(height);
    // A blank tree records a root of zero — `root()` is `None` until the tree is rehashed, and that
    // is exactly the value the runtime writes for a fresh field.
    let mut roots: HashMap<AlignedValue, StateValue<DB>, DB> = HashMap::new();
    roots = roots.insert(field_key(root_of(&tree)), StateValue::Null);
    for (index, leaf) in leaves.iter().enumerate() {
        // `rehash` is required, not an optimisation: Midnight's trees are lazily hashed and `root()`
        // returns `Some` only afterwards. Skipping it silently records another zero root — the whole
        // history collapses to one entry and every membership proof against it fails.
        tree = tree
            .try_update_hash(index as u64, *leaf, ())
            .map_err(|e| format!("insert leaf {index} into a height-{height} tree: {e:?}"))?
            .rehash();
        roots = roots.insert(field_key(root_of(&tree)), StateValue::Null);
    }
    let mut arr: Array<StateValue<DB>, DB> = Array::new();
    arr = arr.push(StateValue::BoundedMerkleTree(tree));
    arr = arr.push(cell(if leaves.is_empty() {
        counter_zero()
    } else {
        counter_of(leaves.len() as u64)
    }));
    arr = arr.push(StateValue::Map(roots));
    Ok(StateValue::Array(arr))
}

/// A tree's root as a field element, treating the blank tree's absent root as zero — which is what
/// the runtime records.
fn root_of(tree: &MerkleTree<(), DB>) -> Fr {
    tree.root().map(|digest| digest.0).unwrap_or_default()
}

/// The ledger state `circle.compact`'s constructor produces.
///
/// Mirrors:
/// ```text
/// constructor(id, open, founder, founderAuth, founderJoined) {
///   circleId = disclose(id);
///   isOpen = disclose(open);
///   members.insert(disclose(founder));
///   moderators.insert(disclose(founder));
///   joinedIdentities.insert(disclose(founderJoined));
///   moderatorAuth.insert(disclose(founder), disclose(founderAuth));
/// }
/// ```
/// `inviteAuthority` is the one field the constructor does **not** write: a circle is born delegating
/// to nobody, and `setInviteAuthority` is the only writer.
pub fn circle_ledger_state(
    circle_id: [u8; 32],
    is_open: bool,
    founder: [u8; 32],
    founder_auth: [u8; 32],
    founder_joined: [u8; 32],
) -> Result<StateValue<DB>, String> {
    let founder_leaf = midnight_transient_crypto::merkle_tree::leaf_hash(&ValueReprAlignedValue(
        AlignedValue::from(HashOutput(founder)),
    ));

    let fields: [StateValue<DB>; LEDGER_FIELDS] = [
        cell(AlignedValue::from(HashOutput(circle_id))), // 0 circleId
        cell(bool_cell(is_open)),                        // 1 isOpen
        // The founder is seated in **both** trees: they moderate and they are a member, which is what
        // makes a gated circle creatable in one transaction instead of deploy → self-invite → join.
        historic_merkle_tree(MEMBERS_HEIGHT, &[founder_leaf])?, // 2 members
        historic_merkle_tree(MODERATORS_HEIGHT, &[founder_leaf])?, // 3 moderators
        empty_map(),                                     // 4 invites
        // Seated with the leaf, never without it: a founder whose nullifier were absent could `join`
        // later and hold a second member leaf, which is the one thing this set exists to prevent.
        set_of_one(founder_joined),                      // 5 joinedIdentities
        map_of_one(founder, founder_auth),               // 6 moderatorAuth
        // Unassigned by the constructor. Zero means nobody, and `isInviteAuthority` checks for it
        // explicitly rather than trusting that no secret hashes to zero.
        cell(zero_bytes32_cell()),                       // 7 inviteAuthority
    ];
    let arr = fields
        .into_iter()
        .fold(Array::new(), |arr, field| arr.push(field));
    Ok(StateValue::Array(arr))
}

/// The `ContractState` a circle deploys with: the constructor's ledger state, one verifier key per
/// entry point, and a **deliberately unsatisfiable** maintenance authority.
///
/// `verifier_keys` are the tagged `managed/circle/keys/<circuit>.verifier` bytes, keyed by circuit
/// name; every entry in [`CIRCLE_ENTRY_POINTS`] must be present.
///
/// **Circles are immutable by decision** (`docs/CONTRACT_MIGRATION.md`). The default authority is
/// `committee: []` with `threshold: 1`, which can never be met, so no circle's verifier keys can be
/// swapped and no authority can be installed later. It also has to be a fixed value rather than a
/// sampled key, because it feeds the address.
pub fn circle_contract_state(
    circle_id: [u8; 32],
    is_open: bool,
    founder: [u8; 32],
    founder_auth: [u8; 32],
    founder_joined: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<ContractState<DB>, String> {
    let mut operations: HashMap<EntryPointBuf, ContractOperation, DB> = HashMap::new();
    for entry_point in CIRCLE_ENTRY_POINTS {
        let bytes = verifier_keys
            .iter()
            .find(|(name, _)| *name == entry_point)
            .map(|(_, bytes)| bytes)
            .ok_or_else(|| format!("missing verifier key for entry point `{entry_point}`"))?;
        let vk: VerifierKey = tagged_deserialize(&mut &bytes[..])
            .map_err(|e| format!("deserialize verifier key for `{entry_point}`: {e}"))?;
        operations = operations.insert(
            EntryPointBuf(entry_point.as_bytes().to_vec()),
            ContractOperation::new(Some(vk)),
        );
    }
    Ok(ContractState {
        data: ChargedState::new(circle_ledger_state(
            circle_id,
            is_open,
            founder,
            founder_auth,
            founder_joined,
        )?),
        operations,
        maintenance_authority: ContractMaintenanceAuthority::default(),
        balance: HashMap::new(),
    })
}

/// Read every entry point's verifier key from a compiled-artifact directory (`<dir>/<name>.verifier`,
/// i.e. `contract/managed/circle/keys` or the app's artifact cache).
///
/// A directory rather than eleven paths across the FFI: the bridges already pass static artifacts as
/// paths, and the set of entry points is fixed by the contract, not by the caller.
pub fn read_circle_verifier_keys(keys_dir: &str) -> Result<Vec<(&'static str, Vec<u8>)>, String> {
    CIRCLE_ENTRY_POINTS
        .iter()
        .map(|name| {
            let path = std::path::Path::new(keys_dir).join(format!("{name}.verifier"));
            std::fs::read(&path)
                .map(|bytes| (*name, bytes))
                .map_err(|e| format!("read verifier key {}: {e}", path.display()))
        })
        .collect()
}

/// `nonce = persistentHash([domain "pnyx:circle", circleId])` — the derivation that makes a
/// circle's address reproducible by anyone holding its constructor arguments.
pub fn circle_deploy_nonce(circle_id: [u8; 32]) -> HashOutput {
    let mut input = Vec::with_capacity(64);
    let mut tag = [0u8; 32];
    let label = b"pnyx:circle";
    tag[..label.len()].copy_from_slice(label);
    input.extend_from_slice(&tag);
    input.extend_from_slice(&circle_id);
    persistent_hash(&input)
}

/// The `ContractDeploy` for a circle: the constructor's state plus the derived nonce.
///
/// Built by struct literal rather than `ContractDeploy::new`, which would sample the nonce and throw
/// away the only property this whole path exists for.
pub fn circle_deploy(
    circle_id: [u8; 32],
    is_open: bool,
    founder: [u8; 32],
    founder_auth: [u8; 32],
    founder_joined: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<ContractDeploy<DB>, String> {
    Ok(ContractDeploy {
        initial_state: circle_contract_state(
            circle_id,
            is_open,
            founder,
            founder_auth,
            founder_joined,
            verifier_keys,
        )?,
        nonce: circle_deploy_nonce(circle_id),
    })
}

/// The address a circle will deploy to — `SHA-256(tagged_serialize(ContractDeploy))`.
///
/// Derivable offline by anyone holding `(circleId, isOpen, founder)` and this template, which is what
/// lets a client verify that the address it was handed is the one the circle's own arguments imply.
pub fn circle_deploy_address(
    circle_id: [u8; 32],
    is_open: bool,
    founder: [u8; 32],
    founder_auth: [u8; 32],
    founder_joined: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<[u8; 32], String> {
    let deploy = circle_deploy(circle_id, is_open, founder, founder_auth, founder_joined, verifier_keys)?;
    Ok(address_of(&deploy))
}

fn address_of(deploy: &ContractDeploy<DB>) -> [u8; 32] {
    let ContractAddress(HashOutput(bytes)) = deploy.address();
    bytes
}

/// An unproven, unbalanced deploy transaction for a circle, tagged-serialized for the sponsor to
/// balance and submit. Returns the bytes **and** the address they will create, so a caller never has
/// to trust anyone else's answer to "which contract did that create?".
#[allow(clippy::too_many_arguments)]
pub fn build_circle_deploy_tx(
    circle_id: [u8; 32],
    is_open: bool,
    founder: [u8; 32],
    founder_auth: [u8; 32],
    founder_joined: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
    network_id: &str,
    ttl_secs: u64,
) -> Result<(Vec<u8>, [u8; 32]), String> {
    let deploy = circle_deploy(circle_id, is_open, founder, founder_auth, founder_joined, verifier_keys)?;
    let address = address_of(&deploy);
    let bytes = crate::tx::assemble_deploy_tx(deploy, network_id, ttl_secs)?;
    Ok((bytes, address))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The address, state-equality and immutability properties need the compiled verifier keys, so they
    // live in `tests/build_circle_deploy.rs` against the real artifacts. What is left here is the one
    // thing that needs no artifacts at all.

    /// A deploy missing an entry point is a *different contract* with a different address, not a
    /// slightly incomplete one — so it has to be refused rather than silently built.
    #[test]
    fn a_missing_verifier_key_is_an_error_not_a_different_contract() {
        let err = circle_contract_state([1u8; 32], true, [2u8; 32], [3u8; 32], [4u8; 32], &[]).expect_err("must reject");
        assert!(err.contains("missing verifier key"), "got: {err}");
    }
}

// ── `identity.compact`, `handle.compact`, `payment.compact` ──
//
// The same shape as a circle's deploy, for the same reason: a contract's address is
// `SHA-256(tagged_serialize(ContractDeploy {initial_state, nonce}))`, so fixing the nonce makes the
// address a *function of the constructor's arguments*. That is the whole of the bounded-state
// design's uniqueness claim — a second claim of one name derives the same address and the chain
// refuses it as `ContractAlreadyDeployed`, with nothing downloaded to find out.
//
// ⚠️ **This cannot be done through the JS ledger.** `ContractDeploy::new` samples its nonce from
// `OsRng` and the wasm binding exposes no alternative, so an SDK-built deploy has a random address
// and a name has no canonical contract. The Rust struct's `nonce` field is public, which is the only
// reason any of this is reachable.

/// The 5 `export ledger` fields of `identity.compact`, in declaration order.
const IDENTITY_LEDGER_FIELDS: usize = 5;
/// The 6 of `handle.compact`.
const HANDLE_LEDGER_FIELDS: usize = 6;
/// The 4 of `payment.compact`.
const PAYMENT_LEDGER_FIELDS: usize = 4;
/// The 9 of `proposal.compact`.
const PROPOSAL_LEDGER_FIELDS: usize = 9;

pub const IDENTITY_ENTRY_POINTS: [&str; 4] = ["publishRow", "setPrimaryName", "setRow", "setRows"];
pub const HANDLE_ENTRY_POINTS: [&str; 4] = ["bind", "rebind", "moderate", "revoke"];
pub const PAYMENT_ENTRY_POINTS: [&str; 8] = [
    "setPrice",
    "buyPermitUnshielded",
    "buyPermitShielded",
    "claimFreePermit",
    "grantPermit",
    "grantRebindPermit",
    "grantModeratePermit",
    "rotateAdmin",
];

/// A `Bytes<32>` cell. Trailing zeros are trimmed, so `pad(32, "")` is an **empty** atom rather than
/// thirty-two zero bytes — the shape the runtime actually writes, and the address hashes it.
fn bytes32_cell(bytes: [u8; 32]) -> StateValue<DB> {
    cell(AlignedValue::from(HashOutput(bytes)))
}

/// A `Uint<8>` atom. Zero is an **empty** atom, not a zero byte — the shape the runtime writes.
fn u8_aligned(n: u8) -> AlignedValue {
    AlignedValue::new(
        Value(vec![ValueAtom(if n == 0 { Vec::new() } else { vec![n] })]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: 1,
        })]),
    )
    .expect("a 1-byte integer fits its alignment")
}

/// A `Field` cell, as `proposal.compact`'s sealed `membersRoot` holds.
fn field_aligned(x: Fr) -> AlignedValue {
    AlignedValue::new(
        Value(vec![ValueAtom::from(x)]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Field)]),
    )
    .expect("a field element fits its alignment")
}

/// `Either<A, B>` as the runtime encodes it: the discriminant, then **both** arms' payloads, with the
/// unused one an empty atom.
fn either_cell(is_left: bool, left: [u8; 32], right: [u8; 32]) -> StateValue<DB> {
    let trim = |b: [u8; 32]| {
        let end = b.iter().rposition(|x| *x != 0).map_or(0, |i| i + 1);
        ValueAtom(b[..end].to_vec())
    };
    cell(
        AlignedValue::new(
            Value(vec![ValueAtom::from(is_left), trim(left), trim(right)]),
            Alignment(vec![
                AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }),
                AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
                AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
            ]),
        )
        .expect("an either fits its alignment"),
    )
}

fn contract_state_of(
    ledger: StateValue<DB>,
    entry_points: &[&str],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<ContractState<DB>, String> {
    let mut operations: HashMap<EntryPointBuf, ContractOperation, DB> = HashMap::new();
    for entry_point in entry_points {
        let bytes = verifier_keys
            .iter()
            .find(|(name, _)| name == entry_point)
            .map(|(_, bytes)| bytes)
            .ok_or_else(|| format!("missing verifier key for entry point `{entry_point}`"))?;
        let vk: VerifierKey = tagged_deserialize(&mut &bytes[..])
            .map_err(|e| format!("deserialize verifier key for `{entry_point}`: {e}"))?;
        operations = operations.insert(
            EntryPointBuf(entry_point.as_bytes().to_vec()),
            ContractOperation::new(Some(vk)),
        );
    }
    Ok(ContractState {
        data: ChargedState::new(ledger),
        operations,
        maintenance_authority: ContractMaintenanceAuthority::default(),
        balance: HashMap::new(),
    })
}

/// Read every entry point's verifier key from a compiled-artifact directory.
pub fn read_verifier_keys(
    keys_dir: &str,
    entry_points: &[&'static str],
) -> Result<Vec<(&'static str, Vec<u8>)>, String> {
    entry_points
        .iter()
        .map(|name| {
            let path = std::path::Path::new(keys_dir).join(format!("{name}.verifier"));
            std::fs::read(&path)
                .map(|bytes| (*name, bytes))
                .map_err(|e| format!("read verifier key {}: {e}", path.display()))
        })
        .collect()
}

/// A `pad(32, "label")` domain tag — the same left-aligned, zero-padded shape Compact produces.
fn domain_tag(label: &[u8]) -> [u8; 32] {
    let mut tag = [0u8; 32];
    tag[..label.len()].copy_from_slice(label);
    tag
}

fn nonce_of(label: &[u8], payload: &[u8; 32]) -> HashOutput {
    let tag = domain_tag(label);
    let mut input = Vec::with_capacity(64);
    input.extend_from_slice(&tag);
    input.extend_from_slice(payload);
    persistent_hash(&input)
}

/// `nonce = persistentHash([domain "pnyx:identity", C])` — mirrors `identityDeployNonce` in
/// `derivations.ts`.
pub fn identity_deploy_nonce(c: [u8; 32]) -> HashOutput {
    nonce_of(b"pnyx:identity", &c)
}

/// `nonce = persistentHash([domain "pnyx:handle", name])` — mirrors `handleDeployNonce`. The name
/// is the **canonical, case-folded** spelling, which is what makes `Alice` and `alice` one contract.
pub fn handle_deploy_nonce(name: [u8; 32]) -> HashOutput {
    nonce_of(b"pnyx:handle", &name)
}

/// `identity.compact`'s constructor: `id = c`, and the other three cells `pad(32, "")`.
pub fn identity_ledger_state(c: [u8; 32]) -> StateValue<DB> {
    let fields: [StateValue<DB>; IDENTITY_LEDGER_FIELDS] = [
        bytes32_cell(c),         // 0 id
        bytes32_cell([0u8; 32]), // 1 anchor
        bytes32_cell([0u8; 32]), // 2 authPub
        bytes32_cell([0u8; 32]), // 3 primaryName
        empty_map(),             // 4 card
    ];
    StateValue::Array(
        fields
            .into_iter()
            .fold(Array::new(), |arr, field| arr.push(field)),
    )
}

/// The mint domain of a name's moderation capability — `handle.compact`'s sealed `moderateDomain`, and
/// the colour `payment.grantModeratePermit` mints. Mirrors `handleModerateDomain` in `derivations.ts`.
pub fn handle_moderate_domain(name: [u8; 32]) -> [u8; 32] {
    nonce_of(b"pnyx:moderate", &name).0
}

/// `handle.compact`'s constructor: the sealed name, payment address and derived moderation domain, with
/// an unowned, unbanned, unburned shell.
///
/// The domain is derived here rather than passed in, exactly as the constructor derives it, so the two
/// cannot disagree — a mismatch would silently move the address.
pub fn handle_ledger_state(name: [u8; 32], payment: [u8; 32]) -> StateValue<DB> {
    let fields: [StateValue<DB>; HANDLE_LEDGER_FIELDS] = [
        bytes32_cell(name),                         // 0 name
        bytes32_cell(payment),                      // 1 payment
        bytes32_cell(handle_moderate_domain(name)), // 2 moderateDomain
        bytes32_cell([0u8; 32]),                    // 3 owner
        cell(bool_cell(false)),                     // 4 banned
        cell(bool_cell(false)),                     // 5 burned
    ];
    StateValue::Array(
        fields
            .into_iter()
            .fold(Array::new(), |arr, field| arr.push(field)),
    )
}

/// `payment.compact`'s constructor: two sealed treasuries, the admin hash, and an empty price map.
pub fn payment_ledger_state(
    treasury: (bool, [u8; 32], [u8; 32]),
    shielded_treasury: (bool, [u8; 32], [u8; 32]),
    admin_auth: [u8; 32],
) -> StateValue<DB> {
    let fields: [StateValue<DB>; PAYMENT_LEDGER_FIELDS] = [
        either_cell(treasury.0, treasury.1, treasury.2), // 0 treasury
        either_cell(
            shielded_treasury.0,
            shielded_treasury.1,
            shielded_treasury.2,
        ), // 1 shieldedTreasury
        bytes32_cell(admin_auth),                        // 2 adminAuth
        empty_map(),                                     // 3 prices
    ];
    StateValue::Array(
        fields
            .into_iter()
            .fold(Array::new(), |arr, field| arr.push(field)),
    )
}

/// The mint... no — the **vote domain** `proposal.compact` seals: `persistentHash(["pnyx:an",
/// circleId, content])`, computed in its constructor. Mirrors `proposalVoteDomain` in
/// `circle-derivations.ts`, and it is what makes the per-vote nullifier an arity-2 hash.
pub fn proposal_vote_domain(circle_id: [u8; 32], content: [u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(96);
    input.extend_from_slice(&domain_tag(b"pnyx:an"));
    input.extend_from_slice(&circle_id);
    input.extend_from_slice(&content);
    persistent_hash(&input).0
}

/// `nonce = persistentHash(["pnyx:proposal", circleId, content])` — mirrors `proposalDeployNonce`.
/// The id *is* the content commitment, so two authors of different content never conflict and two
/// authors of the same content collide, which is what removes `createProposal` as a circuit.
pub fn proposal_deploy_nonce(circle_id: [u8; 32], content: [u8; 32]) -> HashOutput {
    let mut input = Vec::with_capacity(96);
    input.extend_from_slice(&domain_tag(b"pnyx:proposal"));
    input.extend_from_slice(&circle_id);
    input.extend_from_slice(&content);
    persistent_hash(&input)
}

/// `proposal.compact`'s constructor: five sealed cells, the derived vote domain, `tallies` seeded
/// `0..optionCount-1` at zero, and empty `voted` / `commits`.
///
/// ⚠️ A seeded tally is an **empty** `Uint<64>` atom, not eight zero bytes — the same trap as a counter.
/// And the map is keyed by a 1-byte option whose zero is also an empty atom.
pub fn proposal_ledger_state(
    circle_id: [u8; 32],
    members_root: Fr,
    content: [u8; 32],
    author: [u8; 32],
    option_count: u8,
) -> Result<StateValue<DB>, String> {
    if option_count < 2 || option_count > 8 {
        return Err(format!("optionCount must be 2..8, got {option_count}"));
    }
    let mut tallies: HashMap<AlignedValue, StateValue<DB>, DB> = HashMap::new();
    for option in 0..option_count {
        tallies = tallies.insert(u8_aligned(option), cell(counter_zero()));
    }
    let fields: [StateValue<DB>; PROPOSAL_LEDGER_FIELDS] = [
        bytes32_cell(circle_id),                                // 0 circleId
        cell(field_aligned(members_root)),                      // 1 membersRoot
        bytes32_cell(content),                                  // 2 content
        bytes32_cell(author),                                   // 3 author
        cell(u8_aligned(option_count)),                         // 4 optionCount
        bytes32_cell(proposal_vote_domain(circle_id, content)), // 5 voteDomain
        StateValue::Map(tallies),                               // 6 tallies
        empty_map(),                                            // 7 voted
        empty_map(),                                            // 8 commits
    ];
    Ok(StateValue::Array(
        fields
            .into_iter()
            .fold(Array::new(), |arr, field| arr.push(field)),
    ))
}

pub fn proposal_deploy(
    circle_id: [u8; 32],
    members_root: Fr,
    content: [u8; 32],
    author: [u8; 32],
    option_count: u8,
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<ContractDeploy<DB>, String> {
    Ok(ContractDeploy {
        initial_state: contract_state_of(
            proposal_ledger_state(circle_id, members_root, content, author, option_count)?,
            &PROPOSAL_ENTRY_POINTS,
            verifier_keys,
        )?,
        nonce: proposal_deploy_nonce(circle_id, content),
    })
}

/// The address a proposal deploys to — derivable by anyone holding the circle id and the content
/// commitment, which is what lets a client find a proposal without a registry.
pub fn proposal_deploy_address(
    circle_id: [u8; 32],
    members_root: Fr,
    content: [u8; 32],
    author: [u8; 32],
    option_count: u8,
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<[u8; 32], String> {
    Ok(address_of(&proposal_deploy(
        circle_id,
        members_root,
        content,
        author,
        option_count,
        verifier_keys,
    )?))
}

#[allow(clippy::too_many_arguments)]
pub fn build_proposal_deploy_tx(
    circle_id: [u8; 32],
    members_root: Fr,
    content: [u8; 32],
    author: [u8; 32],
    option_count: u8,
    verifier_keys: &[(&str, Vec<u8>)],
    network_id: &str,
    ttl_secs: u64,
) -> Result<(Vec<u8>, [u8; 32]), String> {
    let deploy = proposal_deploy(
        circle_id,
        members_root,
        content,
        author,
        option_count,
        verifier_keys,
    )?;
    let address = address_of(&deploy);
    Ok((
        crate::tx::assemble_deploy_tx(deploy, network_id, ttl_secs)?,
        address,
    ))
}

pub fn proposal_contract_state_for_test(
    circle_id: [u8; 32],
    members_root: Fr,
    content: [u8; 32],
    author: [u8; 32],
    option_count: u8,
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<ContractState<DB>, String> {
    contract_state_of(
        proposal_ledger_state(circle_id, members_root, content, author, option_count)?,
        &PROPOSAL_ENTRY_POINTS,
        verifier_keys,
    )
}

pub fn identity_deploy(
    c: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<ContractDeploy<DB>, String> {
    Ok(ContractDeploy {
        initial_state: contract_state_of(
            identity_ledger_state(c),
            &IDENTITY_ENTRY_POINTS,
            verifier_keys,
        )?,
        nonce: identity_deploy_nonce(c),
    })
}

pub fn handle_deploy(
    name: [u8; 32],
    payment: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<ContractDeploy<DB>, String> {
    Ok(ContractDeploy {
        initial_state: contract_state_of(
            handle_ledger_state(name, payment),
            &HANDLE_ENTRY_POINTS,
            verifier_keys,
        )?,
        nonce: handle_deploy_nonce(name),
    })
}

/// The address an identity contract deploys to, derivable by anyone holding `C`.
pub fn identity_deploy_address(
    c: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<[u8; 32], String> {
    Ok(address_of(&identity_deploy(c, verifier_keys)?))
}

/// The address a handle contract deploys to, derivable by anyone holding the canonical name.
///
/// This is what makes a name lookup free: a client hashes the name, gets the address, and asks the
/// indexer whether anything is there. Nothing is downloaded to discover that a name is taken.
pub fn handle_deploy_address(
    name: [u8; 32],
    payment: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<[u8; 32], String> {
    Ok(address_of(&handle_deploy(name, payment, verifier_keys)?))
}

/// `payment.compact` deploys **once**, so its nonce is a fixed domain tag rather than a function of
/// anything: there is nothing to key it by, and a sampled nonce would make the address unverifiable.
pub fn payment_deploy(
    treasury: (bool, [u8; 32], [u8; 32]),
    shielded_treasury: (bool, [u8; 32], [u8; 32]),
    admin_auth: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<ContractDeploy<DB>, String> {
    Ok(ContractDeploy {
        initial_state: contract_state_of(
            payment_ledger_state(treasury, shielded_treasury, admin_auth),
            &PAYMENT_ENTRY_POINTS,
            verifier_keys,
        )?,
        nonce: nonce_of(b"pnyx:payment", &admin_auth),
    })
}

pub fn payment_deploy_address(
    treasury: (bool, [u8; 32], [u8; 32]),
    shielded_treasury: (bool, [u8; 32], [u8; 32]),
    admin_auth: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<[u8; 32], String> {
    Ok(address_of(&payment_deploy(
        treasury,
        shielded_treasury,
        admin_auth,
        verifier_keys,
    )?))
}

/// Unproven, unbalanced deploy transactions, tagged-serialized for the sponsor to balance and submit.
/// Each returns the bytes **and** the address they will create.
pub fn build_identity_deploy_tx(
    c: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
    network_id: &str,
    ttl_secs: u64,
) -> Result<(Vec<u8>, [u8; 32]), String> {
    let deploy = identity_deploy(c, verifier_keys)?;
    let address = address_of(&deploy);
    Ok((
        crate::tx::assemble_deploy_tx(deploy, network_id, ttl_secs)?,
        address,
    ))
}

#[allow(clippy::too_many_arguments)]
pub fn build_handle_deploy_tx(
    name: [u8; 32],
    payment: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
    network_id: &str,
    ttl_secs: u64,
) -> Result<(Vec<u8>, [u8; 32]), String> {
    let deploy = handle_deploy(name, payment, verifier_keys)?;
    let address = address_of(&deploy);
    Ok((
        crate::tx::assemble_deploy_tx(deploy, network_id, ttl_secs)?,
        address,
    ))
}

#[allow(clippy::too_many_arguments)]
pub fn build_payment_deploy_tx(
    treasury: (bool, [u8; 32], [u8; 32]),
    shielded_treasury: (bool, [u8; 32], [u8; 32]),
    admin_auth: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
    network_id: &str,
    ttl_secs: u64,
) -> Result<(Vec<u8>, [u8; 32]), String> {
    let deploy = payment_deploy(treasury, shielded_treasury, admin_auth, verifier_keys)?;
    let address = address_of(&deploy);
    Ok((
        crate::tx::assemble_deploy_tx(deploy, network_id, ttl_secs)?,
        address,
    ))
}

/// The `ContractState` each contract deploys with — exposed so the deploy tests can compare it
/// against the compiled constructor's own output, which is the only thing that catches a wrong cell.
pub fn identity_contract_state_for_test(
    c: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<ContractState<DB>, String> {
    contract_state_of(
        identity_ledger_state(c),
        &IDENTITY_ENTRY_POINTS,
        verifier_keys,
    )
}

pub fn handle_contract_state_for_test(
    name: [u8; 32],
    payment: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<ContractState<DB>, String> {
    contract_state_of(
        handle_ledger_state(name, payment),
        &HANDLE_ENTRY_POINTS,
        verifier_keys,
    )
}

pub fn payment_contract_state_for_test(
    treasury: (bool, [u8; 32], [u8; 32]),
    shielded_treasury: (bool, [u8; 32], [u8; 32]),
    admin_auth: [u8; 32],
    verifier_keys: &[(&str, Vec<u8>)],
) -> Result<ContractState<DB>, String> {
    contract_state_of(
        payment_ledger_state(treasury, shielded_treasury, admin_auth),
        &PAYMENT_ENTRY_POINTS,
        verifier_keys,
    )
}
