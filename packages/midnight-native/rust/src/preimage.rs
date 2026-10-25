//! Native construction of the forum circuits' `ProofPreimage`s — `join`, `castVote`,
//! `createProposal`, `revealVote` on `circle.compact`, and `publishIdentityRow` on
//! `identity.compact`.
//!
//! **Creating a circle is not here**: a circle is a contract, so it is a deploy rather than a call
//! (`crate::deploy`), and a constructor is not a circuit, so there is nothing to prove.
//!
//! Each builder reproduces, in Rust, what the compact runtime
//! (`contract/managed/<target>/contract/index.js`, `_<circuit>_0`) does when it builds an unproven
//! contract call: it computes the domain-separated
//! hashes, assembles the impact op program that queries/mutates the ledger, runs that program
//! against the contract state to produce a public transcript, and packages the whole thing as a
//! `ProofPreimage` — the exact tagged form that [`crate::prove::prove_circuit`] consumes. The
//! shared tail is [`assemble_preimage`]; the members-tree Merkle witness (`castVote`,
//! `createProposal`) is [`member_merkle_path`].
//!
//! The output is byte-for-byte a `ProofPreimageVersioned::V2`, identical in every deterministic
//! field to the JS-produced preimage; only the freshly sampled communication-commitment randomness
//! differs, which does not affect proving.
//!
//! Regenerate the per-circuit inputs (initial contract state + address) with the matching
//! `packages/midnight-native/scripts/dump-*-preimage.mts` script.

use crate::state_read::{ANCHOR_SLOT, AUTH_PUB_SLOT, CARD_SLOT, ID_SLOT, PRIMARY_NAME_SLOT};
use midnight_base_crypto::fab::{
    AlignedValue, Alignment, AlignmentAtom, AlignmentSegment, Value, ValueAtom,
};
use midnight_base_crypto::hash::{persistent_commit, persistent_hash, HashOutput};

// Shared with the state readers, which are not gated behind `proving` — see `crate::derivations`.
pub use crate::derivations::{domain, free_color, permit_domain, price_key};
use midnight_coin_structure::coin::UserAddress;
use midnight_coin_structure::contract::ContractAddress;
use midnight_ledger::construct::{ContractCallExt, ContractCallPrototype};
use midnight_ledger::structure::UtxoOutput;
use midnight_onchain_runtime::context::QueryContext;
use midnight_onchain_runtime::cost_model::INITIAL_COST_MODEL;
use midnight_onchain_runtime::ops::{Key, Op};
use midnight_onchain_runtime::result_mode::ResultModeVerify;
use midnight_onchain_runtime::state::{
    ChargedState, ContractOperation, ContractState, EntryPointBuf, StateValue,
};
use midnight_onchain_runtime::transcript::Transcript;
use midnight_serialize::{tagged_deserialize, tagged_serialize};
use midnight_storage::arena::Sp;
use midnight_storage::DefaultDB;
use midnight_transient_crypto::curve::Fr;
use midnight_transient_crypto::fab::{AlignedValueExt, ValueReprAlignedValue};
use midnight_transient_crypto::hash::{degrade_to_transient, transient_commit, transient_hash};
use midnight_transient_crypto::merkle_tree::leaf_hash;
use midnight_transient_crypto::proofs::{KeyLocation, ProofPreimage};
use rand::rngs::OsRng;
use rand::Rng;
use std::borrow::Cow;

type DB = DefaultDB;
type VerifyOp = Op<ResultModeVerify, DB>;

// ── `circle.compact` ledger layout ──
//
// Straight from `contract/managed/circle/compiler/contract-info.json`, which lists every
// `export ledger` field with its index. Named because an op program full of bare integers is
// unreviewable, and because a wrong index fails as "leaf not present" rather than as a layout error.
const CIRCLE_ID_IDX: usize = 0;
const IS_OPEN_IDX: usize = 1;
const MEMBERS_IDX: usize = 2;
/// Was 6 until the split deleted `spentInvites` from between `invites` and this
/// (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10). Verified against the compiled circuit's own transcript
/// with `dump-transcript.mts join`, ops 7 and 11 — not derived from the source by eye.
const MODERATORS_IDX: usize = 3;
const INVITES_IDX: usize = 4;
const JOINED_IDENTITIES_IDX: usize = 5;
/// `moderatorAuth`, appended last so no existing index moved. Verified against the compiled circuit's
/// own transcript (`dump-transcript.mts addModerator`, op 29) rather than read off the source.
const MODERATOR_AUTH_IDX: usize = 6;
/// `inviteAuthority`, appended after `moderatorAuth` for the same reason. Verified against
/// `dump-transcript.mts issueInvite` op 1 and `setInviteAuthority` op 6, and pinned against the
/// compiled metadata by `circle_slots_match_the_compiled_contract`.
const INVITE_AUTHORITY_IDX: usize = 7;

/// The invite secret an **open** join hashes and then never asserts on. See [`build_join_preimage`].
const UNUSED_INVITE_SECRET: [u8; 32] = [0u8; 32];

// ── The contract's domain-separated derivations ──
//
// One definition each, mirroring `contract/circle.compact` and its TypeScript twin
// `packages/contract-client/src/circle-derivations.ts`. All three must agree byte-for-byte or a proof
// built here will not verify against the compiled circuit. The unit tests at the bottom pin these
// against values the **compiled circuit itself** emitted, read off its transcript.
//
// The TypeScript twin is `circle-derivations.ts`, not `derivations.ts`: the latter is the spike's
// (`memberLeaf(circleId, sk)`, `openJoinNullifier`, a three-element `actionNullifier`) and dies with
// `pnyx.compact` in `docs/CONTRACT_MIGRATION.md` P6.

/// `personaCommitment = persistentHash([domain "pnyx:pc", sk])`
fn persona_commitment(persona_sk: [u8; 32]) -> HashOutput {
    let mut input = Vec::with_capacity(64);
    input.extend_from_slice(&domain(b"pnyx:pc"));
    input.extend_from_slice(&persona_sk);
    persistent_hash(&input)
}

/// `inviteCommitment = persistentHash([domain "pnyx:invite", inviteSecret])` — what a moderator
/// publishes with `setInvite` and what a gated `join` redeems.
///
/// ⚠️ **No `circleId`**, unlike every other derivation here. It does not need one: the commitment
/// only ever lives in this circle's own `invites` set, so a collision across circles would require
/// the same secret, which is the same invite. The spike's `inviteNullifier` did hash `circleId`, and
/// deleting it is what removed three ops from `join`'s transcript.
fn invite_commitment(invite_secret: [u8; 32]) -> HashOutput {
    let mut input = Vec::with_capacity(64);
    input.extend_from_slice(&domain(b"pnyx:invite"));
    input.extend_from_slice(&invite_secret);
    persistent_hash(&input)
}

/// `inviteAuthorityCommitment = persistentHash([domain "pnyx:ia", sk])` — what a circle stores in
/// `inviteAuthority`, and what its delegated issuer proves knowledge of.
///
/// Its own domain tag, so the same secret used as a persona elsewhere cannot be replayed as an
/// authority. The TypeScript twin is `circle-derivations.ts`'s `inviteAuthorityCommitment`.
pub(crate) fn invite_authority_commitment(authority_sk: [u8; 32]) -> HashOutput {
    let mut input = Vec::with_capacity(64);
    input.extend_from_slice(&domain(b"pnyx:ia"));
    input.extend_from_slice(&authority_sk);
    persistent_hash(&input)
}

/// `identityJoinNullifier = persistentHash([domain "pnyx:jni", circleId, identitySk])` —
/// `circle.compact`'s replacement for the spike's `openJoinNullifier`.
///
/// Two differences that matter and neither is visible from the calling circuit: `circleId` is now a
/// `Bytes<32>` **ledger cell** the circuit reads (so the transcript carries an extra
/// `dup`/`idx(0)`/`popeq`), and the secret is the **identity** secret rather than the persona's —
/// which is what makes one join per identity hold against a client inventing extra personas.
fn identity_join_nullifier(circle_id: [u8; 32], identity_sk: [u8; 32]) -> HashOutput {
    let mut input = Vec::with_capacity(96);
    input.extend_from_slice(&domain(b"pnyx:jni"));
    input.extend_from_slice(&circle_id);
    input.extend_from_slice(&identity_sk);
    persistent_hash(&input)
}

/// A `Bytes<32>` cell (`StateValue::Cell` of a 32-byte aligned value), as pushed by the circuit.
fn bytes32_cell(hash: HashOutput) -> StateValue<DB> {
    StateValue::Cell(Sp::new(AlignedValue::from(hash)))
}

/// An impact `idx` key for a small map/array index (`_descriptor_19`: 1-byte unsigned integer).
fn index_key(n: u8) -> Key {
    let bytes = if n == 0 { Vec::new() } else { vec![n] };
    let value = AlignedValue::new(
        Value(vec![ValueAtom(bytes)]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: 1,
        })]),
    )
    .expect("1-byte index fits its alignment");
    Key::Value(value)
}

/// A single-element impact `idx` path.
fn idx(cached: bool, push_path: bool, index: u8) -> VerifyOp {
    idx_key(cached, push_path, index_key(index))
}

/// A single-element impact `idx` path with an arbitrary key (map lookup by a `Bytes<32>` /
/// `Field` key, e.g. `voteCommits[actionNullifier]`).
fn idx_key(cached: bool, push_path: bool, key: Key) -> VerifyOp {
    Op::Idx {
        cached,
        push_path,
        path: vec![key].into_iter().collect(),
    }
}

/// The `Boolean` (`_descriptor_3`) value a membership `popeq` reads back — always `false` here,
/// since a fresh open circle has neither joined nor banned this join nullifier.
fn bool_false() -> AlignedValue {
    AlignedValue::new(
        Value(vec![ValueAtom(Vec::new())]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: 1,
        })]),
    )
    .expect("boolean fits its alignment")
}

/// A `Boolean` (`_descriptor_3`) `popeq` result of `true` — the root-membership check reads this
/// back, since the path root the circuit computed IS one of the members tree's historic roots.
fn bool_true() -> AlignedValue {
    AlignedValue::new(
        Value(vec![ValueAtom::from(true)]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: 1,
        })]),
    )
    .expect("boolean fits its alignment")
}

/// Build + validate the `join` `ContractCallPrototype`, **for an open circle**.
///
/// `circle.compact` merged `joinCircle` and `joinOpenCircle` into one entry point (a deploy carries
/// one verifier key per entry point and eleven did not fit in a block —
/// `docs/CONTRACT_MIGRATION.md`). One circuit, but **two transcripts**: the invite checks are guarded
/// by `open ||`, so on an open circle they short-circuit and never touch `invites` or `spentInvites`,
/// while a gated join reads both and inserts the spent nullifier. This builds the open one, which is
/// the only join the device rail performs — `joinCircle` never had a native builder and the gated
/// path still does not.
///
/// The merge cost exactly one extra op triple: `inviteNullifier(secret)` hashes `circleId` and is
/// computed before the short-circuited assert, so the transcript reads `circleId` **twice** — once
/// for it and once for `identityJoinNullifier`. Nothing in the circuit body suggests either read;
/// both come from the nullifier helpers.
///
/// `contract_state` is the JS-serialized initial `ContractState` (see the dump script);
/// `contract_address` is its 32-byte address. Every hash and op is computed here — nothing is read
/// from a fixture. The assembled program is run against the state in `ResultModeVerify`, so a
/// malformed transcript (bad hash, wrong op, stale state) is rejected before the prototype is
/// returned. Feeds either [`build_join_preimage`] or [`build_join_proven_tx`].
fn join_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    circle_id: [u8; 32],
    invite: Option<[u8; 32]>,
    identity_sk: [u8; 32],
    persona_sk: [u8; 32],
) -> Result<ContractCallPrototype<DB>, String> {
    // One parameter decides the arm, so "open circle with an invite" and "gated circle without one"
    // are not expressible. Getting it wrong is loud rather than quiet: the program is run against the
    // real state in `ResultModeVerify` below, and the `isOpen` popeq alone rejects the wrong arm.
    let is_open = invite.is_none();
    let invite_secret = invite.unwrap_or(UNUSED_INVITE_SECRET);
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));

    // --- Circuit hashes (mirror `_persistentHash_0/1`, `_personaCommitment_0`, `leafHash`) ---

    let jn = identity_join_nullifier(circle_id, identity_sk);

    // The members tree holds `personaCommitment(personaSk)` directly now — per-circle contracts mean
    // the leaf no longer has to bind a circleId to keep one tree serving every circle.
    let member_leaf_cell = AlignedValue::from(persona_commitment(persona_sk));
    let member_leaf_hash = leaf_hash(&ValueReprAlignedValue(member_leaf_cell));

    // --- Impact op program, mirroring the transcript `dump-transcript.mts join` prints ---
    // Ledger field layout (contract/managed/circle/compiler/contract-info.json): 0 circleId,
    // 1 isOpen, 2 members (tree at [2][0], counter at [2][1], history at [2][2]),
    // 5 joinedIdentities. Inside `members` the sub-indices are the struct's own and did not move.
    // The gated arm reads and spends an invite; the open one short-circuits both because
    // `assert(open || invites.member(c))` never evaluates its right side. Same circuit, two programs.
    let commitment = invite_commitment(invite_secret);
    let invite_check: Vec<VerifyOp> = if is_open {
        Vec::new()
    } else {
        vec![
            // assert invites.member(inviteCommitment(secret)) — the `open ||` guard's right side.
            Op::Dup { n: 0 },
            idx(false, false, INVITES_IDX as u8),
            Op::Push {
                storage: false,
                value: bytes32_cell(commitment),
            },
            Op::Member,
            Op::Popeq {
                cached: true,
                result: bool_true(),
            },
        ]
    };
    // Single-use by **absence**: spending an invite removes its commitment, so a replay fails as "no
    // such invite" rather than needing a spent-nullifier set to grow for ever.
    let invite_spend: Vec<VerifyOp> = if is_open {
        Vec::new()
    } else {
        vec![
            idx(false, true, INVITES_IDX as u8),
            Op::Push {
                storage: false,
                value: bytes32_cell(commitment),
            },
            Op::Rem { cached: false },
            Op::Ins { cached: true, n: 1 },
        ]
    };

    let program: Vec<VerifyOp> = [
        vec![
            // assert isOpen — the *value read*, not an assertion that it is true. A gated circle
            // reads `false` here and then has to satisfy the invite check below.
            Op::Dup { n: 0 },
            idx(false, false, IS_OPEN_IDX as u8),
            Op::Popeq {
                cached: false,
                result: if is_open { bool_true() } else { bool_false() },
            },
        ],
        invite_check,
        vec![
        // circleId, once — read by `identityJoinNullifier` hashing the cell, not visible in the
        // circuit body. It used to be read *twice*, the second for `inviteNullifier`; deleting that
        // nullifier removed three ops, and leaving them in shifted every public input after them
        // ("Public transcript input mismatch for input 23"). Verified against
        // `dump-transcript.mts join`, which is the ground truth here.
        Op::Dup { n: 0 },
        idx(false, false, CIRCLE_ID_IDX as u8),
        Op::Popeq {
            cached: false,
            result: AlignedValue::from(HashOutput(circle_id)),
        },
        // assert !member(joinedIdentities, jn)
        Op::Dup { n: 0 },
        idx(false, false, JOINED_IDENTITIES_IDX as u8),
        Op::Push {
            storage: false,
            value: bytes32_cell(jn),
        },
        Op::Member,
        Op::Popeq {
            cached: true,
            result: bool_false(),
        },
        ],
        invite_spend,
        vec![
        // joinedIdentities.insert(jn, null)
        idx(false, true, JOINED_IDENTITIES_IDX as u8),
        Op::Push {
            storage: false,
            value: bytes32_cell(jn),
        },
        Op::Push {
            storage: true,
            value: StateValue::Null,
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
        Op::Ins { cached: true, n: 1 },
        // members tree: insert leafHash(personaCommitment); bump counter; recompute root
        idx(false, true, MEMBERS_IDX as u8),
        idx(false, true, 0),
        Op::Dup { n: 2 },
        idx(false, false, 1),
        Op::Push {
            storage: true,
            value: bytes32_cell(member_leaf_hash),
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
        Op::Ins { cached: true, n: 1 },
        idx(false, true, 1),
        Op::Addi { immediate: 1 },
        Op::Ins { cached: true, n: 1 },
        idx(false, true, 2),
        Op::Dup { n: 2 },
        idx(false, false, 0),
        Op::Root,
        Op::Push {
            storage: true,
            value: StateValue::Null,
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
        Op::Ins { cached: true, n: 2 },
        ],
    ]
    .concat();

    // `join()` takes no arguments — the circle is the contract.
    let input = AlignedValue::from(());
    let output = AlignedValue::from(());
    // Witness order is CALL order, and the merge changed it: `inviteSecret()` is read first (for the
    // commitment and the invite nullifier) even on the open path, where its value goes unused.
    let private_transcript_outputs = vec![
        AlignedValue::from(HashOutput(invite_secret)),
        AlignedValue::from(HashOutput(identity_sk)),
        AlignedValue::from(HashOutput(persona_sk)),
    ];

    build_prototype(
        contract_state.data,
        address,
        b"join",
        "join",
        program,
        private_transcript_outputs,
        input,
        output,
    )
}

/// Build + tagged-serialize the standalone `join` `ProofPreimage` (the input to
/// [`crate::prove::prove_circuit`]).
///
/// `invite` is `None` for an open circle and `Some(secret)` for a gated one. On the open path the
/// circuit still computes the invite commitment from the witness but asserts on neither side of
/// `open ||`, so the value is unconstrained and zeros stand in — the private transcript never leaves
/// the device and the proof binds to no public consequence of it.
pub fn build_join_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    circle_id: [u8; 32],
    invite: Option<[u8; 32]>,
    identity_sk: [u8; 32],
    persona_sk: [u8; 32],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(join_prototype(
        contract_state,
        contract_address,
        circle_id,
        invite,
        identity_sk,
        persona_sk,
    )?)
}

/// Build the proven-unbound `join` transaction bytes (build preimage → tx-level prove → serialize),
/// ready for `chain-client`'s `submitProven`. `zkir`/`prover_key`/`verifier_key`/`params` are the
/// circuit's artifacts; `network_id`/`ttl_secs` bind the transaction (see
/// [`crate::tx::assemble_proven_tx`]).
///
/// `invite` is `None` for an open circle and `Some(secret)` for a gated one — the same secret whose
/// commitment a moderator published with `setInvite`, and which this call spends by removing it.
#[allow(clippy::too_many_arguments)]
pub fn build_join_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    circle_id: [u8; 32],
    invite: Option<[u8; 32]>,
    identity_sk: [u8; 32],
    persona_sk: [u8; 32],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = join_prototype(
        contract_state,
        contract_address,
        circle_id,
        invite,
        identity_sk,
        persona_sk,
    )?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

/// Shared middle of the native builders: run `program` against `data` in `ResultModeVerify`
/// (rejecting a malformed transcript — every `popeq` result and path/insert is checked against the
/// real state), wrap the result in a guaranteed `Transcript`, and build the `ContractCallPrototype`.
/// The prototype feeds either [`prototype_to_preimage`] (the standalone-preimage path, proven by the
/// `prove_*_preimage` tests) or [`crate::tx::assemble_proven_tx`] (the full proven-tx path). Only
/// the freshly sampled communication-commitment randomness is non-deterministic.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_prototype(
    data: ChargedState<DB>,
    address: ContractAddress,
    entry_point: &[u8],
    key_location: &'static str,
    program: Vec<VerifyOp>,
    private_transcript_outputs: Vec<AlignedValue>,
    input: AlignedValue,
    output: AlignedValue,
) -> Result<ContractCallPrototype<DB>, String> {
    let query_context = QueryContext::new(data, address);
    let results = query_context
        .query::<ResultModeVerify>(&program, None, &INITIAL_COST_MODEL)
        .map_err(|e| format!("transcript rejected by runtime: {e:?}"))?;

    // The declared gas is a BUDGET, not a statement of cost. The node's replay adds a
    // charged-state update cost that depends on its own storage rc-map sharing
    // (onchain-runtime `QueryContext::query` → `state_cost`), which a dry-run against a
    // freshly deserialized snapshot cannot reproduce — declaring the exact dry-run figure
    // fails at inclusion with `Transcript(Execution(OutOfGas))`. midnight-js declares a
    // padded envelope for the same reason (~1.2x the time dimensions); byte dimensions vary
    // more across rc-map topologies, so they get a wider margin. Overstatement only raises
    // the DUST fee the sponsor pays for the declared budget.
    let dry_run = results.gas_cost;
    let gas = midnight_base_crypto::cost_model::RunningCost {
        read_time: dry_run.read_time * 2u64,
        compute_time: dry_run.compute_time * 2u64,
        bytes_written: dry_run.bytes_written.saturating_mul(4),
        bytes_deleted: dry_run.bytes_deleted.saturating_mul(4),
    };
    let transcript = Transcript {
        gas,
        effects: results.context.effects.clone(),
        program: program.into_iter().collect(),
        version: Some(Sp::new(Transcript::<DB>::VERSION)),
    };

    let communication_commitment_rand: Fr = OsRng.gen();
    Ok(ContractCallPrototype {
        address,
        entry_point: EntryPointBuf(entry_point.to_vec()),
        op: ContractOperation::new(None),
        // The call body goes in the FALLIBLE slot, mirroring midnight-js 4.1.1 on ledger 8.1:
        // the guaranteed phase has its own execution budget (independent of the declared gas,
        // which the node's replay matches exactly), and a Merkle-inserting call exceeds it —
        // the node rejects with `guaranteed execution would fail: Transcript(Execution(OutOfGas))`.
        // The fallible phase is fee-backed, so the declared gas is the budget.
        guaranteed_public_transcript: None,
        fallible_public_transcript: Some(transcript),
        private_transcript_outputs,
        input,
        output,
        communication_commitment_rand,
        key_location: KeyLocation(Cow::Borrowed(key_location)),
    })
}

/// Construct + tagged-serialize the standalone `ProofPreimage` from a built prototype (the input to
/// [`crate::prove::prove_circuit`]).
pub(crate) fn prototype_to_preimage(
    prototype: ContractCallPrototype<DB>,
) -> Result<Vec<u8>, String> {
    // The communications commitment binds the value-only field repr of input‖output (matching
    // `Intent::add_call`), not the alignment-framed repr the public `communication_commitment`
    // helper uses — the prover checks against this value-only form.
    let mut io_repr = Vec::with_capacity(
        prototype.input.value_only_field_size() + prototype.output.value_only_field_size(),
    );
    prototype.input.value_only_field_repr(&mut io_repr);
    prototype.output.value_only_field_repr(&mut io_repr);
    let comm = transient_commit(&io_repr[..], prototype.communication_commitment_rand);
    let versioned = <ProofPreimage as ContractCallExt<DB>>::construct_proof(&prototype, comm);

    let mut bytes = Vec::new();
    tagged_serialize(&versioned, &mut bytes)
        .map_err(|e| format!("serialize proof preimage: {e}"))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Same inputs and expected outputs as `packages/contract-client/src/derivations.test.ts`.
    // The two sets of constants are duplicated on purpose: they are the cross-language contract,
    // so changing one language's derivation without the other fails a test on that side. Keep them
    // in sync, and keep both in sync with `contract/pnyx.compact`.
    const SK: [u8; 32] = [0x0b; 32];
    /// The identity secret and circleId `dump-join-preimage.mts` uses.
    const IDENTITY_SK: [u8; 32] = [0x07; 32];
    const CIRCLE_ID: [u8; 32] = [0x01; 32];

    const PERSONA_COMMITMENT: &str =
        "3084874f4d175d5696db6822d3f485d5077b16b0f2d264b035adddc2a011f135";
    /// Read off `join`'s own transcript (`dump-transcript.mts join`, the value the
    /// circuit pushes at op 8) — so this pins the Rust derivation against the **compiled circuit**
    /// rather than against another hand-written copy of the same formula.
    const IDENTITY_JOIN_NULLIFIER: &str =
        "f27f56666ab187a20048db29cd616ca94ad432622284a28efaa603d40ddb7e5c";
    /// Likewise op 20: `leafHash(personaCommitment(personaSk))`, the leaf the members tree receives.
    const MEMBER_LEAF_HASH: &str =
        "c6e7d251d8a6b6d37699e4e5f5d2bf6edfae082a0adb79e4e36b8d6099e6ce71";
    /// `actionNullifier(circleId, 1, sk)` — four elements now, where the spike's hashed three. Pinned
    /// on both sides, because the shape change is exactly the kind that produces a valid-looking
    /// nullifier the contract has never seen.

    #[test]
    fn persona_commitment_matches_pinned_vector() {
        assert_eq!(hex::encode(persona_commitment(SK).0), PERSONA_COMMITMENT);
    }

    #[test]
    fn identity_join_nullifier_matches_the_compiled_circuit() {
        assert_eq!(
            hex::encode(identity_join_nullifier(CIRCLE_ID, IDENTITY_SK).0),
            IDENTITY_JOIN_NULLIFIER
        );
    }

    /// `C = identityCommitment(0x07 x32)`, the same vector `derivations.test.ts` pins. Nothing else
    /// compared the two languages' identity commitment — the row-decode tests all start from a state
    /// this code already wrote, so they would agree with a wrong derivation.
    #[test]
    fn identity_commitment_matches_pinned_vector() {
        assert_eq!(
            hex::encode(super::identity_commitment(IDENTITY_SK).0),
            "0aae573460035f37e38d60674d20f8be84c6519bca7e19ac2da68798afa92a12"
        );
    }

    /// The members tree stores `leafHash(personaCommitment(sk))` — the leaf hash, not the commitment.
    #[test]
    fn member_leaf_hash_matches_the_compiled_circuit() {
        let leaf = leaf_hash(&ValueReprAlignedValue(AlignedValue::from(
            persona_commitment(SK),
        )));
        assert_eq!(hex::encode(leaf.0), MEMBER_LEAF_HASH);
    }

    /// Domain separation is the point of the tags: the same secret under two different purposes
    /// must not collide, and the same purpose must separate on its id argument.
    #[test]
    fn derivations_are_domain_separated() {
        let pc = hex::encode(persona_commitment(SK).0);
        let jn = hex::encode(identity_join_nullifier(CIRCLE_ID, SK).0);
        let distinct = std::collections::HashSet::from([pc.clone(), jn.clone()]);
        assert_eq!(distinct.len(), 2, "two derivations collided: {distinct:?}");

        // The same purpose separates on its circle, which is what keeps a persona unlinkable across
        // circles. The vote nullifier that used to be checked here moved to `proposal.compact`, where
        // it is an arity-2 hash over a sealed `voteDomain` rather than (domain, circleId, id, sk) —
        // pinned by `circle-derivations.test.ts` until the native prototypes are ported.
        let other_circle = [0x02u8; 32];
        assert_ne!(jn, hex::encode(identity_join_nullifier(other_circle, SK).0));
    }
}

// ── publishIdentityRow (docs/PNYX_IDENTITY_PLAN.md) ──

/// `C = persistentHash([domain "pnyx:id", sk])` — mirrors `identityCommitment` in
/// pnyx.compact and `derivations.ts`. All three must agree byte-for-byte.
fn identity_commitment(identity_sk: [u8; 32]) -> HashOutput {
    let mut input = Vec::with_capacity(64);
    input.extend_from_slice(&domain(b"pnyx:id"));
    input.extend_from_slice(&identity_sk);
    persistent_hash(&input)
}

// ── identity.compact ──────────────────────────────────────────────────────────────────────────────
//
// One contract per identity (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.1), so the row is four
// top-level cells plus the contact card and there is no `identities` map. Every program below is
// mirrored from `dump-transcript.mts` output, not derived from the .compact source by eye — deriving
// them by eye is how you get "Public transcript input mismatch for input 9" with no clue which op
// drifted.

/// A `Bytes<N>` value, trailing zeros dropped, at the alignment the runtime expects.
///
/// **Trimming applies to every `Bytes` cell, not just the ones that obviously need it.** The runtime
/// drops trailing zero bytes, so a value ending in `0x00` must be pushed short or the transcript
/// mismatches. The retired naming prototypes trimmed only the handle and left `anchor`/`authPub` at
/// full width — which happened to work because their fixtures never ended in a zero byte, and would
/// have failed for 1 key in 256. Trimming unconditionally is correct in both cases.
fn bytes_value<const N: usize>(bytes: &[u8]) -> AlignedValue {
    let end = bytes.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
    AlignedValue::new(
        Value(vec![ValueAtom(bytes[..end].to_vec())]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: N as u32,
        })]),
    )
    .expect("bytes value fits its alignment")
}

/// `publishRow(anchor, authPub)`'s public input — two full-width `Bytes<32>` arguments.
fn anchor_auth_input(anchor: [u8; 32], auth_pub: [u8; 32]) -> AlignedValue {
    AlignedValue::new(
        Value(vec![
            ValueAtom::from(HashOutput(anchor)),
            ValueAtom::from(HashOutput(auth_pub)),
        ]),
        Alignment(vec![
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
        ]),
    )
    .expect("two 32-byte arguments fit their alignment")
}

/// A `Bytes<32>` cell — an anchor, an auth key, a handle.
fn bytes32_value(bytes: [u8; 32]) -> AlignedValue {
    bytes_value::<32>(&bytes)
}

/// A 1-byte unsigned integer as a pushed **cell** (a map key or a top-level slot index).
///
/// Zero encodes as an empty atom, same trailing-zero rule.
fn u8_value(n: u8) -> AlignedValue {
    AlignedValue::new(
        Value(vec![ValueAtom(if n == 0 { Vec::new() } else { vec![n] })]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: 1,
        })]),
    )
    .expect("1-byte integer fits its alignment")
}

fn u8_cell(n: u8) -> StateValue<DB> {
    StateValue::Cell(Sp::new(u8_value(n)))
}

/// `CardRow { kind: Uint<8>; value: Bytes<320> }` — two atoms, in declaration order.
fn card_row_value(kind: u8, value: &[u8]) -> AlignedValue {
    let end = value.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
    AlignedValue::new(
        Value(vec![
            ValueAtom(if kind == 0 { Vec::new() } else { vec![kind] }),
            ValueAtom(value[..end].to_vec()),
        ]),
        Alignment(vec![
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 320 }),
        ]),
    )
    .expect("card row fits its alignment")
}

fn card_row_cell(kind: u8, value: &[u8]) -> StateValue<DB> {
    StateValue::Cell(Sp::new(card_row_value(kind, value)))
}

/// `requireOwner()` — the prefix on every entry point, and the whole authorisation model.
///
/// The circuit derives `C` from the `identitySk` witness and compares it to the sealed `id`, so the
/// popeq must reproduce that sealed value. A caller with a different secret proves nothing here: the
/// comparison is inside the circuit, and a different `C` is a different contract address anyway.
fn require_owner_ops(c: HashOutput) -> Vec<VerifyOp> {
    vec![
        Op::Dup { n: 0 },
        idx(false, false, ID_SLOT),
        Op::Popeq {
            cached: false,
            result: AlignedValue::from(c),
        },
    ]
}

/// Whether the card currently holds `slot`. `writeSlot`'s clear arm emits its removal ops **only**
/// when the slot is present, so the transcript depends on state the builder has to read.
fn card_slot_present(state: &StateValue<DB>, slot: u8) -> Result<bool, String> {
    let StateValue::Array(arr) = state else {
        return Err("top-level contract state is not an array".to_string());
    };
    let Some(StateValue::Map(map)) = arr.get(CARD_SLOT as usize) else {
        return Err("contract state is missing the card map".to_string());
    };
    Ok(map.get(&u8_value(slot)).is_some())
}

/// `publishRow(anchor, authPub)` — rotate the two keys.
///
/// **One transcript, unlike its predecessor.** The old `publishIdentityRow` branched on
/// `identities.member(id)` and needed two programs (first publish vs rotation); with one contract per
/// identity the cells always exist, so a first publish and a rotation emit the same nine ops. That is
/// the whole of what the split bought here.
fn publish_row_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    anchor: [u8; 32],
    auth_pub: [u8; 32],
    identity_sk: [u8; 32],
) -> Result<ContractCallPrototype<DB>, String> {
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let c = identity_commitment(identity_sk);

    let mut program = require_owner_ops(c);
    program.extend([
        Op::Push {
            storage: false,
            value: u8_cell(ANCHOR_SLOT),
        },
        Op::Push {
            storage: true,
            value: StateValue::Cell(Sp::new(bytes32_value(anchor))),
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
        Op::Push {
            storage: false,
            value: u8_cell(AUTH_PUB_SLOT),
        },
        Op::Push {
            storage: true,
            value: StateValue::Cell(Sp::new(bytes32_value(auth_pub))),
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
    ]);

    build_prototype(
        contract_state.data,
        address,
        b"publishRow",
        "publishRow",
        program,
        vec![AlignedValue::from(HashOutput(identity_sk))],
        anchor_auth_input(anchor, auth_pub),
        AlignedValue::from(()),
    )
}

/// `setPrimaryName(name)` — point at one of my handles, or at none.
fn set_primary_name_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    name: [u8; 32],
    identity_sk: [u8; 32],
) -> Result<ContractCallPrototype<DB>, String> {
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let c = identity_commitment(identity_sk);

    let mut program = require_owner_ops(c);
    program.extend([
        Op::Push {
            storage: false,
            value: u8_cell(PRIMARY_NAME_SLOT),
        },
        Op::Push {
            storage: true,
            value: StateValue::Cell(Sp::new(bytes32_value(name))),
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
    ]);

    build_prototype(
        contract_state.data,
        address,
        b"setPrimaryName",
        "setPrimaryName",
        program,
        vec![AlignedValue::from(HashOutput(identity_sk))],
        bytes32_value(name),
        AlignedValue::from(()),
    )
}

/// The ops one card slot contributes. Shared by `setRow` and `setRows` because the arms are the same
/// three shapes in both, and the *third* is the one a hand-written builder gets wrong: clearing an
/// absent slot emits the `member` popeq and then **nothing at all**.
fn card_slot_ops(slot: u8, kind: u8, value: &[u8], present: bool) -> Vec<VerifyOp> {
    if kind != 0 {
        return vec![
            idx(false, true, CARD_SLOT),
            Op::Push {
                storage: false,
                value: u8_cell(slot),
            },
            Op::Push {
                storage: true,
                value: card_row_cell(kind, value),
            },
            Op::Ins {
                cached: false,
                n: 1,
            },
            Op::Ins { cached: true, n: 1 },
        ];
    }
    let mut ops = vec![
        Op::Dup { n: 0 },
        idx(false, false, CARD_SLOT),
        Op::Push {
            storage: false,
            value: u8_cell(slot),
        },
        Op::Member,
        Op::Popeq {
            cached: true,
            result: if present { bool_true() } else { bool_false() },
        },
    ];
    if present {
        ops.extend([
            idx(false, true, CARD_SLOT),
            Op::Push {
                storage: false,
                value: u8_cell(slot),
            },
            Op::Rem { cached: false },
            Op::Ins { cached: true, n: 1 },
        ]);
    }
    ops
}

/// `setRow(slot, kind, value)` — change one card row.
///
/// Unlike `setRows`, clearing an absent slot is an **assert failure** in the circuit ("no such row"),
/// not a no-op, so this refuses it here rather than building a transcript the node would reject.
fn set_row_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    slot: u8,
    kind: u8,
    value: &[u8],
    identity_sk: [u8; 32],
) -> Result<ContractCallPrototype<DB>, String> {
    if slot >= 64 {
        return Err(format!(
            "card slot {slot} is out of range (the contract asserts slot < 64)"
        ));
    }
    if value.len() != 320 {
        return Err(format!(
            "card row value must be 320 bytes, got {}",
            value.len()
        ));
    }
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let c = identity_commitment(identity_sk);
    let present = card_slot_present(contract_state.data.get_ref(), slot)?;
    if kind == 0 && !present {
        return Err(format!(
            "cannot clear card slot {slot}: it holds no row (`setRow` asserts 'no such row')"
        ));
    }

    let mut program = require_owner_ops(c);
    program.extend(card_slot_ops(slot, kind, value, present));

    let input = AlignedValue::new(
        Value(vec![
            ValueAtom(if slot == 0 { Vec::new() } else { vec![slot] }),
            ValueAtom(if kind == 0 { Vec::new() } else { vec![kind] }),
            ValueAtom({
                let end = value.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
                value[..end].to_vec()
            }),
        ]),
        Alignment(vec![
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 320 }),
        ]),
    )
    .ok_or_else(|| "setRow arguments do not fit their alignment".to_string())?;

    build_prototype(
        contract_state.data,
        address,
        b"setRow",
        "setRow",
        program,
        vec![AlignedValue::from(HashOutput(identity_sk))],
        input,
        AlignedValue::from(()),
    )
}

/// One entry of a `setRows` batch.
#[derive(Debug, Clone)]
pub struct CardWrite {
    pub slot: u8,
    pub kind: u8,
    /// Exactly 320 bytes. Kind 0 clears the slot and the value is ignored.
    pub value: Vec<u8>,
}

/// `setRows(slots[4], rows[4])` — the "save my card" path.
///
/// The width is fixed at four in the template, so a caller with fewer rows pads with clears aimed at
/// slots it is not writing (`cardBatches` in `card.ts` does exactly that, and must: padding with a
/// slot the batch also writes would delete the row it just wrote).
fn set_rows_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    writes: &[CardWrite],
    identity_sk: [u8; 32],
) -> Result<ContractCallPrototype<DB>, String> {
    if writes.len() != 4 {
        return Err(format!(
            "setRows takes exactly 4 slots, got {}",
            writes.len()
        ));
    }
    for w in writes {
        if w.slot >= 64 {
            return Err(format!(
                "card slot {} is out of range (the contract asserts slot < 64)",
                w.slot
            ));
        }
        if w.value.len() != 320 {
            return Err(format!(
                "card row value must be 320 bytes, got {}",
                w.value.len()
            ));
        }
    }
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let c = identity_commitment(identity_sk);

    // Presence is tracked as the batch walks, not read once up front: an earlier arm in the *same*
    // call can insert or remove a slot a later arm then tests, and `writeSlot` runs against the state
    // its predecessors left behind.
    let mut removed: Vec<u8> = Vec::new();
    let mut inserted: Vec<u8> = Vec::new();
    let mut program = require_owner_ops(c);
    for w in writes {
        let on_chain = card_slot_present(contract_state.data.get_ref(), w.slot)?;
        let present = if inserted.contains(&w.slot) {
            true
        } else if removed.contains(&w.slot) {
            false
        } else {
            on_chain
        };
        program.extend(card_slot_ops(w.slot, w.kind, &w.value, present));
        if w.kind == 0 {
            if present {
                removed.push(w.slot);
                inserted.retain(|s| *s != w.slot);
            }
        } else {
            inserted.push(w.slot);
            removed.retain(|s| *s != w.slot);
        }
    }

    let slots_atoms: Vec<ValueAtom> = writes
        .iter()
        .map(|w| {
            ValueAtom(if w.slot == 0 {
                Vec::new()
            } else {
                vec![w.slot]
            })
        })
        .collect();
    let mut atoms = slots_atoms;
    for w in writes {
        atoms.push(ValueAtom(if w.kind == 0 {
            Vec::new()
        } else {
            vec![w.kind]
        }));
        let end = w.value.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
        atoms.push(ValueAtom(w.value[..end].to_vec()));
    }
    let mut alignment: Vec<AlignmentSegment> = (0..4)
        .map(|_| AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }))
        .collect();
    for _ in 0..4 {
        alignment.push(AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }));
        alignment.push(AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 320 }));
    }
    let input = AlignedValue::new(Value(atoms), Alignment(alignment))
        .ok_or_else(|| "setRows arguments do not fit their alignment".to_string())?;

    build_prototype(
        contract_state.data,
        address,
        b"setRows",
        "setRows",
        program,
        vec![AlignedValue::from(HashOutput(identity_sk))],
        input,
        AlignedValue::from(()),
    )
}

pub fn build_publish_row_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    anchor: [u8; 32],
    auth_pub: [u8; 32],
    identity_sk: [u8; 32],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(publish_row_prototype(
        contract_state,
        contract_address,
        anchor,
        auth_pub,
        identity_sk,
    )?)
}

/// Build the proven-unbound `publishRow` transaction bytes, ready for the service to balance and
/// submit. The device holds `identity_sk` and proves; the sponsor only pays.
#[allow(clippy::too_many_arguments)]
pub fn build_publish_row_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    anchor: [u8; 32],
    auth_pub: [u8; 32],
    identity_sk: [u8; 32],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = publish_row_prototype(
        contract_state,
        contract_address,
        anchor,
        auth_pub,
        identity_sk,
    )?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

pub fn build_set_primary_name_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    name: [u8; 32],
    identity_sk: [u8; 32],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(set_primary_name_prototype(
        contract_state,
        contract_address,
        name,
        identity_sk,
    )?)
}

#[allow(clippy::too_many_arguments)]
pub fn build_set_primary_name_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    name: [u8; 32],
    identity_sk: [u8; 32],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype =
        set_primary_name_prototype(contract_state, contract_address, name, identity_sk)?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

pub fn build_set_row_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    slot: u8,
    kind: u8,
    value: &[u8],
    identity_sk: [u8; 32],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(set_row_prototype(
        contract_state,
        contract_address,
        slot,
        kind,
        value,
        identity_sk,
    )?)
}

#[allow(clippy::too_many_arguments)]
pub fn build_set_row_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    slot: u8,
    kind: u8,
    value: &[u8],
    identity_sk: [u8; 32],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = set_row_prototype(
        contract_state,
        contract_address,
        slot,
        kind,
        value,
        identity_sk,
    )?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

pub fn build_set_rows_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    writes: &[CardWrite],
    identity_sk: [u8; 32],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(set_rows_prototype(
        contract_state,
        contract_address,
        writes,
        identity_sk,
    )?)
}

#[allow(clippy::too_many_arguments)]
pub fn build_set_rows_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    writes: &[CardWrite],
    identity_sk: [u8; 32],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = set_rows_prototype(contract_state, contract_address, writes, identity_sk)?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

// ── `handle.compact` ledger layout ──
//
// From `contract/managed/handle/compiler/contract-info.json`. One deploy per claimed name.
const HANDLE_NAME_SLOT: u8 = 0;
const HANDLE_PAYMENT_SLOT: u8 = 1;
const HANDLE_OWNER_SLOT: u8 = 3;
const HANDLE_BANNED_SLOT: u8 = 4;
const HANDLE_BURNED_SLOT: u8 = 5;

/// The index of `Effects.unshielded_inputs`, which `receiveUnshielded` writes.
///
/// ⚠️ **This is an index into the VM's `Effects` structure, not into the contract state** — the `swap`
/// before it is what moves the stack from one to the other. `handle.compact` declares six ledger
/// fields (0..5), so a 6 that looked like a seventh field is the tell that this is a different
/// container. Confirmed against `midnight-onchain-runtime` `context.rs` (`map_from(arr.get(6))`) and
/// `midnight-ledger`'s `token_vault_common.rs`.
const EFFECTS_UNSHIELDED_INPUTS_IDX: u8 = 6;

/// A `Uint<128>` cell — the amount an unshielded effect carries. Trailing zeros are trimmed, so 1 is a
/// single byte under a 16-byte alignment.
fn u128_value(n: u128) -> AlignedValue {
    let bytes = n.to_be_bytes();
    let start = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    AlignedValue::new(
        Value(vec![ValueAtom(bytes[start..].to_vec())]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: 16,
        })]),
    )
    .expect("128-bit integer fits its alignment")
}

/// `TokenType::Unshielded(color)` as the VM encodes it: a 1-byte variant tag, the 32-byte colour, and
/// an empty third atom for the shielded variant's contract address.
fn unshielded_token_type_value(color: HashOutput) -> AlignedValue {
    let end = color.0.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
    AlignedValue::new(
        Value(vec![
            ValueAtom(vec![1]),
            ValueAtom(color.0[..end].to_vec()),
            ValueAtom(Vec::new()),
        ]),
        Alignment(vec![
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
        ]),
    )
    .expect("token type fits its alignment")
}

/// `Vector<32, Uint<8>>` — the `nameLimbs` witness, as **32 separate one-byte atoms**.
///
/// ⚠️ Not a `Bytes<32>`. A single 32-byte atom is the shape a hand-written port reaches for and it is
/// wrong: the circuit reads the limbs individually to bucket the tier, so the private transcript
/// carries thirty-two atoms. A wrong shape here proves nothing and surfaces as a public-transcript
/// mismatch several layers from the cause.
fn name_limbs_value(name: [u8; 32]) -> AlignedValue {
    AlignedValue::new(
        Value(
            name.iter()
                .map(|b| ValueAtom(if *b == 0 { Vec::new() } else { vec![*b] }))
                .collect(),
        ),
        Alignment(
            (0..32)
                .map(|_| AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }))
                .collect(),
        ),
    )
    .expect("name limbs fit their alignment")
}

/// The permit colour domain for a tier — `pad(32, "pnyx:permit:t<N>")`, mirroring `handle.compact`.
/// `freeColor()` — the reserved colour a free tier's row is written under. A padded label, not a hash:
/// no currency can ever mint under it, which is what keeps free a currency rather than a special case.

/// A name's price tier, from its byte length — the same buckets `nameTier()` computes in-circuit and
/// `handleTier()` computes in TypeScript.
///
/// Length is the index of the first zero byte, which holds because a name is left-aligned UTF-8 and
/// UTF-8 never contains 0x00.
fn handle_tier(name: [u8; 32]) -> u8 {
    let len = name.iter().position(|b| *b == 0).unwrap_or(32);
    match len {
        0..=2 => 0,
        3 => 1,
        4 => 2,
        5..=6 => 3,
        7..=10 => 4,
        11..=22 => 5,
        _ => 6,
    }
}

/// The sixteen ops `receiveUnshielded(color, amount)` compiles to.
///
/// ⚠️ **These are ops, not a separate effects API.** The pair of `swap`s is what moves the VM stack to
/// the `Effects` container and back; everything between them writes `unshielded_inputs`. A port that
/// mirrors only the contract-state ops builds a transcript the node rejects with `EffectsMismatch`,
/// because it replays the program and requires the declared effects to equal the computed ones
/// (`midnight-ledger` `semantics.rs`).
fn receive_unshielded_ops(color: HashOutput, amount: u128) -> Vec<VerifyOp> {
    vec![
        Op::Swap { n: 0 },
        idx(true, true, EFFECTS_UNSHIELDED_INPUTS_IDX),
        Op::Push {
            storage: false,
            value: StateValue::Cell(Sp::new(unshielded_token_type_value(color))),
        },
        Op::Dup { n: 1 },
        Op::Dup { n: 1 },
        Op::Member,
        Op::Push {
            storage: false,
            value: StateValue::Cell(Sp::new(u128_value(amount))),
        },
        Op::Swap { n: 0 },
        Op::Neg,
        Op::Branch { skip: 4 },
        Op::Dup { n: 2 },
        Op::Dup { n: 2 },
        Op::Idx {
            cached: true,
            push_path: false,
            path: vec![Key::Stack].try_into().expect("one-key path"),
        },
        Op::Add,
        Op::Ins { cached: true, n: 2 },
        Op::Swap { n: 0 },
    ]
}

/// `Effects.unshielded_mints`, which `mintUnshieldedToken` credits.
///
/// ⚠️ Keyed by the mint's **domain**, not by the derived token type — a contract can only mint under its
/// own address, so the type is implied and the map holds the raw 32-byte domain. The claimed-spend map
/// below is the one that carries the full type. Both indices read off the `Effects` order the runtime
/// prints: 4 shieldedMints, 5 unshieldedMints, 6 unshieldedInputs, 7 unshieldedOutputs,
/// 8 claimedUnshieldedSpends.
const EFFECTS_UNSHIELDED_MINTS_IDX: u8 = 5;
/// `Effects.claimed_unshielded_spends` — where the minted amount is claimed *to* a recipient.
const EFFECTS_CLAIMED_UNSHIELDED_SPENDS_IDX: u8 = 8;
/// `payment.compact`'s `prices` map. From `contract/managed/payment/compiler/contract-info.json`.
const PAYMENT_PRICES_SLOT: u8 = 3;

/// A `Uint<64>` cell. The mints map counts in 64 bits where the claimed-spends map counts in 128 — a
/// difference that is invisible in the source and fails as a transcript mismatch if guessed.
fn u64_value(n: u64) -> AlignedValue {
    let bytes = n.to_be_bytes();
    let start = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    AlignedValue::new(
        Value(vec![ValueAtom(bytes[start..].to_vec())]),
        Alignment(vec![AlignmentSegment::Atom(AlignmentAtom::Bytes {
            length: 8,
        })]),
    )
    .expect("64-bit integer fits its alignment")
}

/// `(TokenType::Unshielded(color), Either<ContractAddress, UserAddress>)` — the key
/// `claimed_unshielded_spends` is indexed by.
///
/// Six atoms in two groups of three: the token type's variant tag, colour and unused shielded address,
/// then the recipient's `is_left` tag, unused contract address and user address. The recipient here is
/// always the right variant (a user), which is why the tag atom is empty.
fn unshielded_spend_key(color: HashOutput, recipient: [u8; 32]) -> AlignedValue {
    let end = color.0.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
    AlignedValue::new(
        Value(vec![
            ValueAtom(vec![1]),
            ValueAtom(color.0[..end].to_vec()),
            ValueAtom(Vec::new()),
            ValueAtom(Vec::new()),
            ValueAtom(Vec::new()),
            ValueAtom(recipient.to_vec()),
        ]),
        Alignment(vec![
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
        ]),
    )
    .expect("spend key fits its alignment")
}

/// The counter idiom: `map[key] += amount`, inserting the amount when the key is absent.
///
/// Sixteen ops that the compiler emits for every effects-map credit — `member`, push the amount, `neg`,
/// a four-op branch over the insert, then add-and-insert. Shared so the mint and the receive cannot
/// drift apart in it.
fn credit_effects_map(slot: u8, key: AlignedValue, amount: AlignedValue) -> Vec<VerifyOp> {
    vec![
        Op::Swap { n: 0 },
        idx(true, true, slot),
        Op::Push {
            storage: false,
            value: StateValue::Cell(Sp::new(key)),
        },
        Op::Dup { n: 1 },
        Op::Dup { n: 1 },
        Op::Member,
        Op::Push {
            storage: false,
            value: StateValue::Cell(Sp::new(amount)),
        },
        Op::Swap { n: 0 },
        Op::Neg,
        Op::Branch { skip: 4 },
        Op::Dup { n: 2 },
        Op::Dup { n: 2 },
        Op::Idx {
            cached: true,
            push_path: false,
            path: vec![Key::Stack].try_into().expect("one-key path"),
        },
        Op::Add,
        Op::Ins { cached: true, n: 2 },
        Op::Swap { n: 0 },
    ]
}

/// `mintUnshieldedToken(domain, amount, recipient)`.
///
/// Two effects-map credits with a read of the contract's **own address** between them: the runtime hands
/// it back so the claimed spend can name the full token type, which only the minting contract can
/// produce. That read is why this takes `self_address` — a prototype that guessed it would fail as a
/// popeq mismatch with nothing pointing at the address.
fn mint_unshielded_ops(
    domain: [u8; 32],
    amount: u64,
    self_address: ContractAddress,
    recipient: [u8; 32],
) -> Vec<VerifyOp> {
    let color = self_address.custom_unshielded_token_type(HashOutput(domain));
    let mut ops = credit_effects_map(
        EFFECTS_UNSHIELDED_MINTS_IDX,
        bytes32_value(domain),
        u64_value(amount),
    );
    ops.extend([
        Op::Dup { n: 2 },
        Op::Idx {
            cached: true,
            push_path: false,
            path: vec![index_key(0)].try_into().expect("one-key path"),
        },
        Op::Popeq {
            cached: true,
            result: bytes32_value(self_address.0 .0),
        },
    ]);
    ops.extend(credit_effects_map(
        EFFECTS_CLAIMED_UNSHIELDED_SPENDS_IDX,
        unshielded_spend_key(color.0, recipient),
        u128_value(amount as u128),
    ));
    ops
}

/// Read a `Bytes<32>` cell out of the deserialized contract state.
///
/// The builder needs the sealed `name` and `payment` before it can assemble the program: the tier
/// decides which permit colour the transcript claims, and the payment address is half of that colour.
fn read_bytes32_slot(state: &StateValue<DB>, slot: u8) -> Result<[u8; 32], String> {
    let StateValue::Array(arr) = state else {
        return Err("top-level contract state is not an array".to_string());
    };
    let Some(StateValue::Cell(cell)) = arr.get(slot as usize) else {
        return Err(format!("contract state slot {slot} is not a cell"));
    };
    let mut out = [0u8; 32];
    let atom = cell
        .value
        .0
        .first()
        .ok_or_else(|| format!("slot {slot} has no atom"))?;
    if atom.0.len() > 32 {
        return Err(format!(
            "slot {slot} holds {} bytes, expected at most 32",
            atom.0.len()
        ));
    }
    out[..atom.0.len()].copy_from_slice(&atom.0);
    Ok(out)
}

/// `bind()` — claim this name by spending a permit of exactly its tier.
///
/// The reads are in circuit order and the order is load-bearing: `nameTier()` runs first and reads the
/// sealed `name`, then the three guards (`burned`, `banned`, `owner`), then `payment` — which is read
/// only because it is half of the permit colour. The private transcript is `[nameLimbs, identitySk]`,
/// in that order, for the same reason.
fn bind_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    identity_sk: [u8; 32],
) -> Result<ContractCallPrototype<DB>, String> {
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let state = contract_state.data.get_ref();
    let name = read_bytes32_slot(state, HANDLE_NAME_SLOT)?;
    let payment = read_bytes32_slot(state, HANDLE_PAYMENT_SLOT)?;
    let c = identity_commitment(identity_sk);
    let color = ContractAddress(HashOutput(payment))
        .custom_unshielded_token_type(HashOutput(permit_domain(handle_tier(name))));

    let mut program = vec![
        Op::Dup { n: 0 },
        idx(false, false, HANDLE_NAME_SLOT),
        Op::Popeq {
            cached: false,
            result: bytes32_value(name),
        },
        Op::Dup { n: 0 },
        idx(false, false, HANDLE_BURNED_SLOT),
        Op::Popeq {
            cached: false,
            result: bool_false(),
        },
        Op::Dup { n: 0 },
        idx(false, false, HANDLE_BANNED_SLOT),
        Op::Popeq {
            cached: false,
            result: bool_false(),
        },
        Op::Dup { n: 0 },
        idx(false, false, HANDLE_OWNER_SLOT),
        Op::Popeq {
            cached: false,
            result: bytes32_value([0u8; 32]),
        },
        Op::Dup { n: 0 },
        idx(false, false, HANDLE_PAYMENT_SLOT),
        Op::Popeq {
            cached: false,
            result: bytes32_value(payment),
        },
    ];
    program.extend(receive_unshielded_ops(color.0, 1));
    program.extend([
        Op::Push {
            storage: false,
            value: u8_cell(HANDLE_OWNER_SLOT),
        },
        Op::Push {
            storage: true,
            value: StateValue::Cell(Sp::new(bytes32_value(c.0))),
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
    ]);

    build_prototype(
        contract_state.data,
        address,
        b"bind",
        "bind",
        program,
        vec![
            name_limbs_value(name),
            AlignedValue::from(HashOutput(identity_sk)),
        ],
        AlignedValue::from(()),
        AlignedValue::from(()),
    )
}

/// `rebind(newOwner)` — hand the name over, on the **current** owner's authority.
///
/// Same shape as `bind` minus the tier: the rebind permit is per name, so its colour comes from
/// `persistentHash(["pnyx:rebind", name])` rather than from a length bucket. The owner read is a
/// comparison against `C` here rather than against the zero sentinel, which is the whole of the
/// authorisation.
fn rebind_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    new_owner: [u8; 32],
    identity_sk: [u8; 32],
) -> Result<ContractCallPrototype<DB>, String> {
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let state = contract_state.data.get_ref();
    let name = read_bytes32_slot(state, HANDLE_NAME_SLOT)?;
    let payment = read_bytes32_slot(state, HANDLE_PAYMENT_SLOT)?;
    let c = identity_commitment(identity_sk);
    let mut rebind_input = Vec::with_capacity(64);
    rebind_input.extend_from_slice(&domain(b"pnyx:rebind"));
    rebind_input.extend_from_slice(&name);
    let rebind_domain = persistent_hash(&rebind_input);
    let color = ContractAddress(HashOutput(payment)).custom_unshielded_token_type(rebind_domain);

    let mut program = vec![
        Op::Dup { n: 0 },
        idx(false, false, HANDLE_BURNED_SLOT),
        Op::Popeq {
            cached: false,
            result: bool_false(),
        },
        Op::Dup { n: 0 },
        idx(false, false, HANDLE_BANNED_SLOT),
        Op::Popeq {
            cached: false,
            result: bool_false(),
        },
        Op::Dup { n: 0 },
        idx(false, false, HANDLE_OWNER_SLOT),
        Op::Popeq {
            cached: false,
            result: bytes32_value(c.0),
        },
        Op::Dup { n: 0 },
        idx(false, false, HANDLE_NAME_SLOT),
        Op::Popeq {
            cached: false,
            result: bytes32_value(name),
        },
        Op::Dup { n: 0 },
        idx(false, false, HANDLE_PAYMENT_SLOT),
        Op::Popeq {
            cached: false,
            result: bytes32_value(payment),
        },
    ];
    program.extend(receive_unshielded_ops(color.0, 1));
    program.extend([
        Op::Push {
            storage: false,
            value: u8_cell(HANDLE_OWNER_SLOT),
        },
        Op::Push {
            storage: true,
            value: StateValue::Cell(Sp::new(bytes32_value(new_owner))),
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
    ]);

    build_prototype(
        contract_state.data,
        address,
        b"rebind",
        "rebind",
        program,
        vec![AlignedValue::from(HashOutput(identity_sk))],
        bytes32_value(new_owner),
        AlignedValue::from(()),
    )
}

/// `claimFreePermit(tier, recipient)` on `payment.compact` — a permit for a wallet with nothing in it.
///
/// The only gate is a `prices` row under the reserved free colour, so the transcript is one membership
/// check and then the mint. No witness at all: this circuit reads none, which is why the private
/// transcript is empty and a caller supplies nothing secret.
///
/// ⚠️ The **first mint prototype in this crate.** `bind` receives a permit and `moderate` spends one;
/// nothing here had minted before, so the two effects-map credits and the self-address read between them
/// come from `dump-transcript.mts claimFreePermit` rather than from reading the contract.
fn claim_free_permit_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    tier: u8,
    recipient: [u8; 32],
) -> Result<ContractCallPrototype<DB>, String> {
    if tier > 6 {
        return Err(format!("tier must be 0..6, got {tier}"));
    }
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let permit = permit_domain(tier);
    // `priceKey(tier, freeColor())` — the row whose *presence* says this tier is free. Its amount is
    // never read, by the circuit or here.
    let price_key = HashOutput(price_key(tier, free_color()));

    let mut program = vec![
        Op::Dup { n: 0 },
        idx(false, false, PAYMENT_PRICES_SLOT),
        Op::Push {
            storage: false,
            value: StateValue::Cell(Sp::new(bytes32_value(price_key.0))),
        },
        Op::Member,
        Op::Popeq {
            cached: true,
            result: bool_true(),
        },
    ];
    program.extend(mint_unshielded_ops(permit, 1, address, recipient));

    build_prototype(
        contract_state.data,
        address,
        b"claimFreePermit",
        "claimFreePermit",
        program,
        // Empty: the circuit takes no witness.
        vec![],
        claim_free_permit_input(tier, recipient),
        AlignedValue::from(()),
    )
}

/// The circuit's public arguments: `(tier, recipient)`, the recipient being the right variant of
/// `Either<ContractAddress, UserAddress>`.
fn claim_free_permit_input(tier: u8, recipient: [u8; 32]) -> AlignedValue {
    AlignedValue::new(
        Value(vec![
            ValueAtom(if tier == 0 { Vec::new() } else { vec![tier] }),
            ValueAtom(Vec::new()),
            ValueAtom(Vec::new()),
            ValueAtom(recipient.to_vec()),
        ]),
        Alignment(vec![
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
            AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }),
        ]),
    )
    .expect("claimFreePermit input fits its alignment")
}

pub fn build_claim_free_permit_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    tier: u8,
    recipient: [u8; 32],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(claim_free_permit_prototype(
        contract_state,
        contract_address,
        tier,
        recipient,
    )?)
}

/// Build a proven-unbound `claimFreePermit` transaction — a tier permit for a wallet holding nothing.
///
/// The one call in this crate that needs no funding of its own: it spends nothing, so the sponsor's fee
/// segment is all it takes to submit. The permit lands at `recipient` as an ordinary unshielded UTxO,
/// which the later `bind` then spends.
///
/// ⚠️ `recipient` is **disclosed** by the transcript, and `bind` ties the permit to the name — so a
/// caller that reuses its main receive address publishes the link between that address and the handle.
#[allow(clippy::too_many_arguments)]
pub fn build_claim_free_permit_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    tier: u8,
    recipient: [u8; 32],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = claim_free_permit_prototype(contract_state, contract_address, tier, recipient)?;
    // ⚠️ The mint's **output**, without which the node refuses the transaction as
    // `Custom error: 186 — Malformed::EffectsCheckFailure`. The transcript claims an unshielded spend to
    // the recipient; `Transaction::well_formed` requires a matching real output in the same intent and
    // phase. See `crate::tx::assemble_proven_tx_with_mints`.
    let payment = ContractAddress(HashOutput(contract_address));
    let mint = UtxoOutput {
        value: 1,
        owner: UserAddress(HashOutput(recipient)),
        type_: payment.custom_unshielded_token_type(HashOutput(permit_domain(tier))),
    };
    crate::tx::assemble_proven_tx_with_mints(
        prototype,
        &[mint],
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

pub fn build_bind_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    identity_sk: [u8; 32],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(bind_prototype(
        contract_state,
        contract_address,
        identity_sk,
    )?)
}

#[allow(clippy::too_many_arguments)]
pub fn build_bind_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    identity_sk: [u8; 32],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = bind_prototype(contract_state, contract_address, identity_sk)?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

pub fn build_rebind_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    new_owner: [u8; 32],
    identity_sk: [u8; 32],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(rebind_prototype(
        contract_state,
        contract_address,
        new_owner,
        identity_sk,
    )?)
}

#[allow(clippy::too_many_arguments)]
pub fn build_rebind_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    new_owner: [u8; 32],
    identity_sk: [u8; 32],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = rebind_prototype(contract_state, contract_address, new_owner, identity_sk)?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

// ── proposal.compact: castVote and revealVote (docs/BOUNDED_STATE_ARCHITECTURE.md §10) ──
//
// One deploy per proposal, so everything that grows per *vote* lives in its own contract. Both
// transcripts are **guaranteed**, unlike `circle.join`'s fallible one.
//
// ⚠️ The member path is a **parameter**, not something read out of state: the electorate is a snapshot
// and this contract holds no tree. The caller supplies the path as of the sealed root, and the
// circuit's root comparison is the verification — which is why `member_merkle_path` (the whole-state
// deserializer that set the old member ceiling) is not needed here at all.
//
// Ledger field order, from `contract/managed/proposal/compiler/contract-info.json`.
const PROPOSAL_MEMBERS_ROOT_IDX: usize = 1;
const PROPOSAL_OPTION_COUNT_IDX: usize = 4;
const PROPOSAL_VOTE_DOMAIN_IDX: usize = 5;
const PROPOSAL_TALLIES_IDX: usize = 6;
const PROPOSAL_VOTED_IDX: usize = 7;
const PROPOSAL_COMMITS_IDX: usize = 8;

/// A `MerkleTreePath<20, Bytes<32>>` as the private transcript carries it: the leaf, then twenty
/// `[sibling Field, goes_left Boolean]` pairs. Must match the circuit's descriptor exactly.
fn merkle_path_value(leaf: HashOutput, entries: &[(Fr, bool)]) -> AlignedValue {
    let mut values = Vec::with_capacity(1 + 2 * entries.len());
    let mut alignment = Vec::with_capacity(1 + 2 * entries.len());
    values.push(ValueAtom::from(leaf));
    alignment.push(AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 32 }));
    for (sibling, goes_left) in entries {
        values.push(ValueAtom::from(*sibling));
        alignment.push(AlignmentSegment::Atom(AlignmentAtom::Field));
        values.push(ValueAtom::from(*goes_left));
        alignment.push(AlignmentSegment::Atom(AlignmentAtom::Bytes { length: 1 }));
    }
    AlignedValue::new(Value(values), Alignment(alignment)).expect("merkle path fits its alignment")
}

/// Read a top-level cell **verbatim**, so a `popeq` reuses exactly the bytes and alignment the state
/// holds. Decoding and re-encoding would assume how an atom is padded; a zero `Uint<64>` is an *empty*
/// atom, not eight zero bytes, and getting that wrong fails as a transcript mismatch.
fn read_cell_verbatim(state: &StateValue<DB>, idx: usize) -> Result<AlignedValue, String> {
    let arr = match state {
        StateValue::Array(a) => a,
        _ => return Err("top-level contract state is not an array".to_string()),
    };
    match arr.get(idx) {
        Some(StateValue::Cell(cell)) => Ok((**cell).clone()),
        Some(_) => Err(format!("contract state[{idx}] is not a cell")),
        None => Err(format!("contract state[{idx}] missing")),
    }
}

/// Read one entry of a top-level `Map` cell verbatim, plus its decoded `u64`. Used for
/// `tallies[option]`, which `revealVote` reads and writes back incremented.
fn read_map_u64(
    state: &StateValue<DB>,
    idx: usize,
    key: &AlignedValue,
) -> Result<(AlignedValue, u64), String> {
    let arr = match state {
        StateValue::Array(a) => a,
        _ => return Err("top-level contract state is not an array".to_string()),
    };
    let map = match arr.get(idx) {
        Some(StateValue::Map(m)) => m,
        Some(_) => return Err(format!("contract state[{idx}] is not a map")),
        None => return Err(format!("contract state[{idx}] missing")),
    };
    let entry = map.get(key).ok_or_else(|| {
        format!("contract state[{idx}] has no entry for that key — the option was never seeded")
    })?;
    match &*entry {
        StateValue::Cell(cell) => {
            let av: &AlignedValue = cell;
            let n = match av.value.0.first() {
                Some(atom) => {
                    u64::try_from(atom).map_err(|e| format!("decode tally u64: {e:?}"))?
                }
                None => 0,
            };
            Ok((av.clone(), n))
        }
        _ => Err("a tally entry is not a cell".to_string()),
    }
}

/// `persistentHash([voteDomain, personaSk])` — arity 2, because the sealed `voteDomain` already
/// carries the tag, the circle and the proposal. Mirrors `proposalActionNullifier` in
/// `circle-derivations.ts`.
fn proposal_action_nullifier(vote_domain: [u8; 32], persona_sk: [u8; 32]) -> HashOutput {
    let mut input = Vec::with_capacity(64);
    input.extend_from_slice(&vote_domain);
    input.extend_from_slice(&persona_sk);
    persistent_hash(&input)
}

/// `castVote` — commit a sealed ballot. Mirrors `dump-transcript.mts castVote` (21 guaranteed ops).
fn cast_vote_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    ballot_option: u8,
    ballot_rand: [u8; 32],
    member_path: &[(Fr, bool)],
) -> Result<ContractCallPrototype<DB>, String> {
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let data = contract_state.data.get_ref();

    let members_root = read_cell_verbatim(data, PROPOSAL_MEMBERS_ROOT_IDX)?;
    let vote_domain_cell = read_cell_verbatim(data, PROPOSAL_VOTE_DOMAIN_IDX)?;
    let vote_domain = read_bytes32_slot(data, PROPOSAL_VOTE_DOMAIN_IDX as u8)?;
    let an = proposal_action_nullifier(vote_domain, persona_sk);
    let member_leaf = persona_commitment(persona_sk);
    // commit = persistentCommit(Uint<8> option, rand). A `Uint<8>` ballot, not a Boolean — yes/no is
    // just `optionCount = 2`.
    let commit = persistent_commit(
        &ValueReprAlignedValue(u8_value(ballot_option)),
        HashOutput(ballot_rand),
    );

    let program: Vec<VerifyOp> = vec![
        // membersRoot — read by `requireElector`, compared against the path's root in-circuit.
        Op::Dup { n: 0 },
        idx(false, false, PROPOSAL_MEMBERS_ROOT_IDX as u8),
        Op::Popeq {
            cached: false,
            result: members_root,
        },
        // voteDomain — read by the action nullifier, not by the circuit body.
        Op::Dup { n: 0 },
        idx(false, false, PROPOSAL_VOTE_DOMAIN_IDX as u8),
        Op::Popeq {
            cached: false,
            result: vote_domain_cell,
        },
        // assert !member(voted, an)
        Op::Dup { n: 0 },
        idx(false, false, PROPOSAL_VOTED_IDX as u8),
        Op::Push {
            storage: false,
            value: bytes32_cell(an),
        },
        Op::Member,
        Op::Popeq {
            cached: true,
            result: bool_false(),
        },
        // voted.insert(an)
        idx(false, true, PROPOSAL_VOTED_IDX as u8),
        Op::Push {
            storage: false,
            value: bytes32_cell(an),
        },
        Op::Push {
            storage: true,
            value: StateValue::Null,
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
        Op::Ins { cached: true, n: 1 },
        // commits.insert(an, commit)
        idx(false, true, PROPOSAL_COMMITS_IDX as u8),
        Op::Push {
            storage: false,
            value: bytes32_cell(an),
        },
        Op::Push {
            storage: true,
            value: bytes32_cell(commit),
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
        Op::Ins { cached: true, n: 1 },
    ];

    // Circuit order: personaSk, memberPath, ballotOption, ballotRand.
    let private_transcript_outputs = vec![
        AlignedValue::from(HashOutput(persona_sk)),
        merkle_path_value(member_leaf, member_path),
        u8_value(ballot_option),
        AlignedValue::from(HashOutput(ballot_rand)),
    ];

    build_prototype(
        contract_state.data,
        address,
        b"castVote",
        "castVote",
        program,
        private_transcript_outputs,
        AlignedValue::from(()),
        AlignedValue::from(()),
    )
}

/// `revealVote` — open the ballot and count it. Mirrors `dump-transcript.mts revealVote` (28 ops).
///
/// No membership check and no path: the nullifier in `commits` already proves this persona voted while
/// an elector, and a vote should not be voided by a later departure.
fn reveal_vote_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    ballot_option: u8,
    ballot_rand: [u8; 32],
) -> Result<ContractCallPrototype<DB>, String> {
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let data = contract_state.data.get_ref();

    let vote_domain_cell = read_cell_verbatim(data, PROPOSAL_VOTE_DOMAIN_IDX)?;
    let vote_domain = read_bytes32_slot(data, PROPOSAL_VOTE_DOMAIN_IDX as u8)?;
    let option_count_cell = read_cell_verbatim(data, PROPOSAL_OPTION_COUNT_IDX)?;
    let an = proposal_action_nullifier(vote_domain, persona_sk);
    let commit = persistent_commit(
        &ValueReprAlignedValue(u8_value(ballot_option)),
        HashOutput(ballot_rand),
    );

    let option_key = u8_value(ballot_option);
    let (tally_cell, tally) = read_map_u64(data, PROPOSAL_TALLIES_IDX, &option_key)?;
    let next = tally
        .checked_add(1)
        .ok_or_else(|| "a tally overflows u64".to_string())?;
    let updated_tally = AlignedValue::new(
        Value(vec![ValueAtom::from(next)]),
        tally_cell.alignment.clone(),
    )
    .ok_or_else(|| "encode the incremented tally: value does not fit alignment".to_string())?;

    let program: Vec<VerifyOp> = vec![
        // voteDomain — read by the action nullifier.
        Op::Dup { n: 0 },
        idx(false, false, PROPOSAL_VOTE_DOMAIN_IDX as u8),
        Op::Popeq {
            cached: false,
            result: vote_domain_cell,
        },
        // assert member(commits, an)
        Op::Dup { n: 0 },
        idx(false, false, PROPOSAL_COMMITS_IDX as u8),
        Op::Push {
            storage: false,
            value: bytes32_cell(an),
        },
        Op::Member,
        Op::Popeq {
            cached: true,
            result: bool_true(),
        },
        // assert commits[an] == commit — the ballot opens
        Op::Dup { n: 0 },
        idx(false, false, PROPOSAL_COMMITS_IDX as u8),
        idx_key(false, false, Key::Value(AlignedValue::from(an))),
        Op::Popeq {
            cached: false,
            result: AlignedValue::from(commit),
        },
        // optionCount — read by the range check on the disclosed option.
        Op::Dup { n: 0 },
        idx(false, false, PROPOSAL_OPTION_COUNT_IDX as u8),
        Op::Popeq {
            cached: false,
            result: option_count_cell,
        },
        // commits.remove(an) — the ballot is spent by opening it, so the per-vote map shrinks.
        idx(false, true, PROPOSAL_COMMITS_IDX as u8),
        Op::Push {
            storage: false,
            value: bytes32_cell(an),
        },
        Op::Rem { cached: false },
        Op::Ins { cached: true, n: 1 },
        // tallies[option] += 1, at the DISCLOSED index — no in-circuit branching over options.
        Op::Dup { n: 0 },
        idx(false, false, PROPOSAL_TALLIES_IDX as u8),
        idx_key(false, false, Key::Value(option_key.clone())),
        Op::Popeq {
            cached: false,
            result: tally_cell,
        },
        idx(false, true, PROPOSAL_TALLIES_IDX as u8),
        Op::Push {
            storage: false,
            value: StateValue::Cell(Sp::new(option_key)),
        },
        Op::Push {
            storage: true,
            value: StateValue::Cell(Sp::new(updated_tally)),
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
        Op::Ins { cached: true, n: 1 },
    ];

    // Circuit order: personaSk, ballotOption, ballotRand. No path — there is no membership check.
    let private_transcript_outputs = vec![
        AlignedValue::from(HashOutput(persona_sk)),
        u8_value(ballot_option),
        AlignedValue::from(HashOutput(ballot_rand)),
    ];

    build_prototype(
        contract_state.data,
        address,
        b"revealVote",
        "revealVote",
        program,
        private_transcript_outputs,
        AlignedValue::from(()),
        AlignedValue::from(()),
    )
}

/// A member path as it crosses the bridge: twenty `(sibling, goes_left)` pairs, little-endian sibling
/// bytes. Decoded here rather than in the bridge so the encoding lives beside the transcript it feeds.
pub fn member_path_from_bytes(path: &[u8]) -> Result<Vec<(Fr, bool)>, String> {
    tree_path_from_bytes(path, 20, "member")
}

/// The same decoding at a stated depth — `moderators` is a `HistoricMerkleTree<10, …>`, so its paths
/// are half the length.
///
/// ⚠️ The depth is checked rather than inferred from the length. A path of the wrong height still
/// decodes and still hashes to *a* root; it simply matches none, and the circuit reports that as "not
/// a moderator" — a wrong answer wearing the right error.
pub fn moderator_path_from_bytes(path: &[u8]) -> Result<Vec<(Fr, bool)>, String> {
    tree_path_from_bytes(path, 10, "moderator")
}

fn tree_path_from_bytes(path: &[u8], depth: usize, what: &str) -> Result<Vec<(Fr, bool)>, String> {
    const ENTRY: usize = 33;
    if path.len() != depth * ENTRY {
        return Err(format!(
            "a {what} path is {} bytes ({depth} x 33), got {}",
            depth * ENTRY,
            path.len()
        ));
    }
    path.chunks(ENTRY)
        .map(|chunk| {
            let mut sibling = [0u8; 32];
            sibling.copy_from_slice(&chunk[..32]);
            let field = Fr::from_le_bytes(&sibling)
                .ok_or_else(|| "a path sibling is not a field element".to_string())?;
            match chunk[32] {
                0 => Ok((field, false)),
                1 => Ok((field, true)),
                other => Err(format!("goes_left must be 0 or 1, got {other}")),
            }
        })
        .collect()
}

pub fn build_cast_vote_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    ballot_option: u8,
    ballot_rand: [u8; 32],
    member_path: &[(Fr, bool)],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(cast_vote_prototype(
        contract_state,
        contract_address,
        persona_sk,
        ballot_option,
        ballot_rand,
        member_path,
    )?)
}

#[allow(clippy::too_many_arguments)]
pub fn build_cast_vote_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    ballot_option: u8,
    ballot_rand: [u8; 32],
    member_path: &[(Fr, bool)],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = cast_vote_prototype(
        contract_state,
        contract_address,
        persona_sk,
        ballot_option,
        ballot_rand,
        member_path,
    )?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

pub fn build_reveal_vote_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    ballot_option: u8,
    ballot_rand: [u8; 32],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(reveal_vote_prototype(
        contract_state,
        contract_address,
        persona_sk,
        ballot_option,
        ballot_rand,
    )?)
}

#[allow(clippy::too_many_arguments)]
pub fn build_reveal_vote_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    ballot_option: u8,
    ballot_rand: [u8; 32],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = reveal_vote_prototype(
        contract_state,
        contract_address,
        persona_sk,
        ballot_option,
        ballot_rand,
    )?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

// ── `circle.compact`'s moderator-gated circuits ──
//
// ⚠️ **`setInvite` is GUARANTEED and `addModerator` is FALLIBLE**, and nothing tells you which you got
// wrong — a misplaced transcript fails at the node with no mention of the stage. Both verified against
// `dump-transcript.mts setInvite` / `setInvite:revoke` / `addModerator`.

/// The tree root a Merkle path implies — what `merkleTreePathRoot(path)` computes in-circuit.
///
/// The fold is transient-crypto's own (`MerklePath::root`): degrade the leaf hash to a transient field
/// element, then hash each level with the sibling on the side `goes_left` names. Reimplemented over
/// `(Fr, bool)` entries rather than reached through `MerklePath`, because the bridge carries a path as
/// those pairs and rebuilding the typed path would need the tree it came from.
///
/// ⚠️ The **order** inside `transient_hash` is the whole thing: swapping the arms produces a valid
/// field element that matches no root, and the circuit reports it as "not a member".
fn merkle_path_root(leaf: HashOutput, entries: &[(Fr, bool)]) -> Fr {
    entries.iter().fold(
        degrade_to_transient(leaf_hash(&ValueReprAlignedValue(AlignedValue::from(leaf)))),
        |acc, (sibling, goes_left)| {
            if *goes_left {
                transient_hash(&[acc, *sibling])
            } else {
                transient_hash(&[*sibling, acc])
            }
        },
    )
}

/// A field element as the `checkRoot` lookup pushes it — a cell, not the 32-byte form a commitment uses.
fn field_cell(x: Fr) -> StateValue<DB> {
    StateValue::Cell(Sp::new(AlignedValue::from(x)))
}

/// The six ops every moderator-gated circuit opens with: `moderators.checkRoot(root(moderatorPath))`.
///
/// Shared rather than copied: `setInvite` and `addModerator` both begin here, and two copies would let
/// one drift while the other's tests stayed green.
fn require_moderator_ops(
    moderator_leaf: HashOutput,
    moderator_path: &[(Fr, bool)],
) -> Vec<VerifyOp> {
    vec![
        Op::Dup { n: 0 },
        idx(false, false, MODERATORS_IDX as u8),
        // [2] of a HistoricMerkleTree is its root history — `checkRoot` is a map membership test, not a
        // comparison against the live root, which is what lets a proof survive a concurrent insert.
        idx(false, false, 2),
        Op::Push {
            storage: false,
            value: field_cell(merkle_path_root(moderator_leaf, moderator_path)),
        },
        Op::Member,
        Op::Popeq {
            cached: true,
            result: bool_true(),
        },
    ]
}

/// The `invites` write both issuing circuits share — 5 ops inserting, 9 removing.
///
/// Shared because `setInvite` and `issueInvite` have **identical bodies** and differ only in their
/// gate: the contract duplicates the body deliberately (a merged guard costs `setInvite` a K step —
/// see the circuit's own docstring), but there is no reason for the port to duplicate it too, and two
/// copies would let one drift while the other's oracle stayed green.
///
/// The two arms are different programs, not one program with a flag: issuing inserts, revoking asserts
/// the commitment is present and removes it. The `assert(on || invites.member(c))` guard is why
/// revoking reads the map first — a revocation of nothing is the case it exists to name.
fn invite_write_ops(commitment: HashOutput, active: bool) -> Vec<VerifyOp> {
    if active {
        vec![
            idx(false, true, INVITES_IDX as u8),
            Op::Push {
                storage: false,
                value: bytes32_cell(commitment),
            },
            Op::Push {
                storage: true,
                value: StateValue::Null,
            },
            Op::Ins {
                cached: false,
                n: 1,
            },
            Op::Ins { cached: true, n: 1 },
        ]
    } else {
        vec![
            Op::Dup { n: 0 },
            idx(false, false, INVITES_IDX as u8),
            Op::Push {
                storage: false,
                value: bytes32_cell(commitment),
            },
            Op::Member,
            Op::Popeq {
                cached: true,
                result: bool_true(),
            },
            idx(false, true, INVITES_IDX as u8),
            Op::Push {
                storage: false,
                value: bytes32_cell(commitment),
            },
            Op::Rem { cached: false },
            Op::Ins { cached: true, n: 1 },
        ]
    }
}

/// `setInvite(commitment, active)` — issue or revoke, as a **moderator**. **Guaranteed**, 11 ops
/// issuing / 15 revoking.
fn set_invite_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    moderator_path: &[(Fr, bool)],
    commitment: [u8; 32],
    active: bool,
) -> Result<ContractCallPrototype<DB>, String> {
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let moderator_leaf = persona_commitment(persona_sk);

    let mut program = require_moderator_ops(moderator_leaf, moderator_path);
    program.extend(invite_write_ops(HashOutput(commitment), active));

    // Circuit order: personaSk, then moderatorPath — `requireModerator` reads both, in that order.
    let private_transcript_outputs = vec![
        AlignedValue::from(HashOutput(persona_sk)),
        merkle_path_value(moderator_leaf, moderator_path),
    ];
    let input = AlignedValue::from((HashOutput(commitment), active));
    build_prototype(
        contract_state.data,
        address,
        b"setInvite",
        "setInvite",
        program,
        private_transcript_outputs,
        input,
        AlignedValue::from(()),
    )
}

/// The three ops `isInviteAuthority()` contributes: read `inviteAuthority` and disclose it.
///
/// Only the *stored* value is public — the comparison against the caller's own commitment, and the
/// zero check, both happen inside the circuit. So this is the same shape as
/// [`require_owner_ops`]: a `popeq` reproducing a cell the circuit read.
fn require_invite_authority_ops(stored: HashOutput) -> Vec<VerifyOp> {
    vec![
        Op::Dup { n: 0 },
        idx(false, false, INVITE_AUTHORITY_IDX as u8),
        Op::Popeq {
            cached: false,
            result: AlignedValue::from(stored),
        },
    ]
}

/// `issueInvite(commitment, active)` — `setInvite`'s body behind the delegated-authority gate.
/// **Guaranteed**, 8 ops issuing / 12 revoking.
///
/// The caller proves knowledge of `inviteAuthority`'s preimage; there is no moderator path, which is
/// the whole point — the attestation service holds no persona and moderates nothing.
///
/// ⚠️ **Both refusals below are checked here rather than left to the runtime.** The transcript
/// discloses the stored authority, so a caller who is not it would build a transcript that runs and
/// then fails *in the circuit*, as an unsatisfiable constraint several layers from the cause. Naming
/// it costs one state read.
fn issue_invite_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    authority_sk: [u8; 32],
    commitment: [u8; 32],
    active: bool,
) -> Result<ContractCallPrototype<DB>, String> {
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));

    let stored = crate::state_read::bytes32(
        &crate::state_read::cell_atom(&contract_state, INVITE_AUTHORITY_IDX, 0)
            // A never-delegated circle's cell holds all zeros, which encodes as an empty atom — and
            // an absent atom is that same fact, not a malformed state.
            .unwrap_or_default(),
        "inviteAuthority",
    )?;
    if stored == [0u8; 32] {
        return Err("this circle has delegated invite issuance to nobody".to_string());
    }
    if stored != invite_authority_commitment(authority_sk).0 {
        return Err("not this circle's invite authority".to_string());
    }

    let mut program = require_invite_authority_ops(HashOutput(stored));
    program.extend(invite_write_ops(HashOutput(commitment), active));

    let private_transcript_outputs = vec![AlignedValue::from(HashOutput(authority_sk))];
    let input = AlignedValue::from((HashOutput(commitment), active));
    build_prototype(
        contract_state.data,
        address,
        b"issueInvite",
        "issueInvite",
        program,
        private_transcript_outputs,
        input,
        AlignedValue::from(()),
    )
}

/// `setInviteAuthority(authority)` — delegate issuance, rotate the delegate, or withdraw it.
/// Moderator-gated. **Guaranteed**, 9 ops.
///
/// The tail is a plain cell write (`push slot`, `push value`, `ins`), not the `idx(push_path)` shape
/// the map writes above use — a top-level cell is assigned, not indexed into.
fn set_invite_authority_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    moderator_path: &[(Fr, bool)],
    authority: [u8; 32],
) -> Result<ContractCallPrototype<DB>, String> {
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let moderator_leaf = persona_commitment(persona_sk);

    let mut program = require_moderator_ops(moderator_leaf, moderator_path);
    program.extend([
        Op::Push {
            storage: false,
            value: u8_cell(INVITE_AUTHORITY_IDX as u8),
        },
        Op::Push {
            storage: true,
            value: StateValue::Cell(Sp::new(bytes32_value(authority))),
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
    ]);

    let private_transcript_outputs = vec![
        AlignedValue::from(HashOutput(persona_sk)),
        merkle_path_value(moderator_leaf, moderator_path),
    ];
    build_prototype(
        contract_state.data,
        address,
        b"setInviteAuthority",
        "setInviteAuthority",
        program,
        private_transcript_outputs,
        bytes32_value(authority),
        AlignedValue::from(()),
    )
}

/// `addModerator(leaf, authPub)` — promote a member and record their auth key. **Fallible**, 34 ops.
///
/// Two root checks, not one: the caller must moderate (`moderators`) and the target must already be a
/// member (`members`). The insert half is `join`'s members insert against slot 3 — the trees differ in
/// height but the op shape does not.
///
/// The trailing five ops are the `moderatorAuth` map insert. ⚠️ Its key is the **raw** leaf, not the
/// `leaf_hash` the tree insert above uses — a map keys on the aligned value itself. Both appear in the
/// same transcript, so the two are easy to conflate and the failure would be a lookup that never hits.
#[allow(clippy::too_many_arguments)]
fn add_moderator_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    moderator_path: &[(Fr, bool)],
    target_leaf: [u8; 32],
    member_path: &[(Fr, bool)],
    auth_pub: [u8; 32],
) -> Result<ContractCallPrototype<DB>, String> {
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let moderator_leaf = persona_commitment(persona_sk);
    let target = HashOutput(target_leaf);
    let target_leaf_hash = leaf_hash(&ValueReprAlignedValue(AlignedValue::from(target)));

    let mut program = require_moderator_ops(moderator_leaf, moderator_path);
    program.extend([
        // requireMember(leaf) — the same checkRoot shape against `members`.
        Op::Dup { n: 0 },
        idx(false, false, MEMBERS_IDX as u8),
        idx(false, false, 2),
        Op::Push {
            storage: false,
            value: field_cell(merkle_path_root(target, member_path)),
        },
        Op::Member,
        Op::Popeq {
            cached: true,
            result: bool_true(),
        },
        // moderators.insert(leaf): tree, bump the counter, record the new root.
        idx(false, true, MODERATORS_IDX as u8),
        idx(false, true, 0),
        Op::Dup { n: 2 },
        idx(false, false, 1),
        Op::Push {
            storage: true,
            value: bytes32_cell(target_leaf_hash),
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
        Op::Ins { cached: true, n: 1 },
        idx(false, true, 1),
        Op::Addi { immediate: 1 },
        Op::Ins { cached: true, n: 1 },
        idx(false, true, 2),
        Op::Dup { n: 2 },
        idx(false, false, 0),
        Op::Root,
        Op::Push {
            storage: true,
            value: StateValue::Null,
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
        Op::Ins { cached: true, n: 2 },
        // moderatorAuth.insert(leaf, authPub) — key then value, raw leaf bytes for the key.
        idx(false, true, MODERATOR_AUTH_IDX as u8),
        Op::Push {
            storage: false,
            value: bytes32_cell(target),
        },
        Op::Push {
            storage: true,
            value: bytes32_cell(HashOutput(auth_pub)),
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
        Op::Ins { cached: true, n: 1 },
    ]);

    // Circuit order: personaSk and moderatorPath (requireModerator), then memberPath (requireMember).
    // `authPub` is a public argument, so it rides in the input rather than the private transcript.
    let private_transcript_outputs = vec![
        AlignedValue::from(HashOutput(persona_sk)),
        merkle_path_value(moderator_leaf, moderator_path),
        merkle_path_value(target, member_path),
    ];
    let input = AlignedValue::from((target, HashOutput(auth_pub)));
    build_prototype(
        contract_state.data,
        address,
        b"addModerator",
        "addModerator",
        program,
        private_transcript_outputs,
        input,
        AlignedValue::from(()),
    )
}

/// The blank leaf a removal writes — `leafHash(pad(32, ""))`.
///
/// ⚠️ **All-zero is the *empty* atom, not 32 zero bytes.** `AlignedValue` refuses the full-width
/// spelling outright, which is the encoding's trailing-zero rule showing its teeth; the field repr
/// pads back to 32 from the alignment, so the hash is the one the circuit computes.
fn blank_leaf_hash() -> HashOutput {
    leaf_hash(&ValueReprAlignedValue(bytes32_value([0u8; 32])))
}

/// The leaf index a `MerkleTreePath` describes, most-significant bit first.
///
/// The compiler emits this as a twenty-deep fold of `path[i].goes_left ? 0 : 1`, walking **down**
/// from index 19 to 0 — so entry 19 is the root-most sibling and contributes the high bit. Reversing
/// it yields a perfectly valid index for a different leaf, which the tree would blank instead.
fn member_leaf_index(entries: &[(Fr, bool)]) -> u64 {
    entries
        .iter()
        .rev()
        .fold(0u64, |acc, (_, goes_left)| acc * 2 + u64::from(!*goes_left))
}

/// `leaveCircle()` — remove your own leaf. **Fallible**, 30 ops.
///
/// The same removal `setMember` performs for a ban, self-authorised: the caller proves they hold the
/// persona rather than that they moderate, so there is no `moderators` check and the only witness is
/// `personaSk` plus the path to its own leaf.
///
/// ⚠️ **This does not release the join nullifier.** `join` asserts `!joinedIdentities.member(jn)` and
/// nothing ever removes from that set — it is what makes a ban permanent. Leaving reuses the removal
/// and inherits the property, so a leaver cannot rejoin, not even with a fresh invite. That is a
/// product-visible consequence, not an implementation detail: the UI must say so before the tap.
fn leave_circle_prototype(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    member_path: &[(Fr, bool)],
) -> Result<ContractCallPrototype<DB>, String> {
    let contract_state: ContractState<DB> = tagged_deserialize(&mut &contract_state[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(contract_address));
    let leaf = persona_commitment(persona_sk);
    if member_path.len() != 20 {
        return Err(format!(
            "a members path is 20 entries deep, got {}",
            member_path.len()
        ));
    }
    let index = member_leaf_index(member_path);

    let program: Vec<VerifyOp> = vec![
        // assert members.checkRoot(merkleTreePathRoot(memberPath(leaf))) — "not a member". Slot 2 is
        // `members`, sub-index 2 its history map; the same six ops `addModerator` opens with.
        Op::Dup { n: 0 },
        idx(false, false, MEMBERS_IDX as u8),
        idx(false, false, 2),
        Op::Push {
            storage: false,
            value: field_cell(merkle_path_root(leaf, member_path)),
        },
        Op::Member,
        Op::Popeq {
            cached: true,
            result: bool_true(),
        },
        // members.insertIndex(pad(32, ""), idx) — index then value, `ins n: 2`, unlike the plain
        // `insert` in `join` which appends at the counter.
        idx(false, true, MEMBERS_IDX as u8),
        idx(false, true, 0),
        Op::Push {
            storage: false,
            value: StateValue::Cell(Sp::new(u64_value(index))),
        },
        Op::Push {
            storage: true,
            value: bytes32_cell(blank_leaf_hash()),
        },
        Op::Ins {
            cached: false,
            n: 2,
        },
        // counter = max(counter, idx + 1). Never a decrement: the tree's first-free index has to
        // stay monotonic or a later join would reuse the slot this call just blanked. For a leaver
        // it is a no-op, and the branch runs anyway because the program is fixed, not data-driven.
        idx(false, true, 1),
        Op::Push {
            storage: false,
            value: StateValue::Cell(Sp::new(u64_value(index))),
        },
        Op::Addi { immediate: 1 },
        Op::Dup { n: 1 },
        Op::Dup { n: 1 },
        Op::Lt,
        Op::Branch { skip: 2 },
        Op::Pop,
        Op::Jmp { skip: 2 },
        Op::Swap { n: 0 },
        Op::Pop,
        Op::Ins {
            cached: false,
            n: 1,
        },
        // Record the new root in the history map, so paths sealed against it keep verifying.
        idx(false, true, 2),
        Op::Dup { n: 2 },
        idx(false, false, 0),
        Op::Root,
        Op::Push {
            storage: true,
            value: StateValue::Null,
        },
        Op::Ins {
            cached: false,
            n: 1,
        },
        Op::Ins { cached: true, n: 2 },
    ];

    // Circuit order: `personaSk()` is read first (to derive the leaf), then `memberPath(leaf)`.
    let private_transcript_outputs = vec![
        AlignedValue::from(HashOutput(persona_sk)),
        merkle_path_value(leaf, member_path),
    ];
    build_prototype(
        contract_state.data,
        address,
        b"leaveCircle",
        "leaveCircle",
        program,
        private_transcript_outputs,
        AlignedValue::from(()),
        AlignedValue::from(()),
    )
}

/// Standalone `leaveCircle` `ProofPreimage` — the input to [`crate::prove::prove_circuit`].
pub fn build_leave_circle_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    member_path: &[(Fr, bool)],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(leave_circle_prototype(
        contract_state,
        contract_address,
        persona_sk,
        member_path,
    )?)
}

/// Build the proven-unbound `leaveCircle` transaction bytes, ready for `submitProven`.
#[allow(clippy::too_many_arguments)]
pub fn build_leave_circle_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    member_path: &[(Fr, bool)],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype =
        leave_circle_prototype(contract_state, contract_address, persona_sk, member_path)?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

/// Standalone `setInvite` `ProofPreimage` — the input to [`crate::prove::prove_circuit`].
pub fn build_set_invite_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    moderator_path: &[(Fr, bool)],
    commitment: [u8; 32],
    active: bool,
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(set_invite_prototype(
        contract_state,
        contract_address,
        persona_sk,
        moderator_path,
        commitment,
        active,
    )?)
}

/// Standalone `issueInvite` `ProofPreimage` — the delegated authority's own issuance.
pub fn build_issue_invite_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    authority_sk: [u8; 32],
    commitment: [u8; 32],
    active: bool,
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(issue_invite_prototype(
        contract_state,
        contract_address,
        authority_sk,
        commitment,
        active,
    )?)
}

/// Standalone `setInviteAuthority` `ProofPreimage`.
pub fn build_set_invite_authority_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    moderator_path: &[(Fr, bool)],
    authority: [u8; 32],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(set_invite_authority_prototype(
        contract_state,
        contract_address,
        persona_sk,
        moderator_path,
        authority,
    )?)
}

/// Standalone `addModerator` `ProofPreimage`.
#[allow(clippy::too_many_arguments)]
pub fn build_add_moderator_preimage(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    moderator_path: &[(Fr, bool)],
    target_leaf: [u8; 32],
    member_path: &[(Fr, bool)],
    auth_pub: [u8; 32],
) -> Result<Vec<u8>, String> {
    prototype_to_preimage(add_moderator_prototype(
        contract_state,
        contract_address,
        persona_sk,
        moderator_path,
        target_leaf,
        member_path,
        auth_pub,
    )?)
}

/// Build the proven-unbound `setInvite` transaction — ready for `chain-client`'s `submitProven`.
#[allow(clippy::too_many_arguments)]
pub fn build_set_invite_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    moderator_path: &[(Fr, bool)],
    commitment: [u8; 32],
    active: bool,
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = set_invite_prototype(
        contract_state,
        contract_address,
        persona_sk,
        moderator_path,
        commitment,
        active,
    )?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

/// Build the proven-unbound `issueInvite` transaction.
#[allow(clippy::too_many_arguments)]
pub fn build_issue_invite_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    authority_sk: [u8; 32],
    commitment: [u8; 32],
    active: bool,
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = issue_invite_prototype(
        contract_state,
        contract_address,
        authority_sk,
        commitment,
        active,
    )?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

/// Build the proven-unbound `setInviteAuthority` transaction.
#[allow(clippy::too_many_arguments)]
pub fn build_set_invite_authority_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    moderator_path: &[(Fr, bool)],
    authority: [u8; 32],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = set_invite_authority_prototype(
        contract_state,
        contract_address,
        persona_sk,
        moderator_path,
        authority,
    )?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

/// Build the proven-unbound `addModerator` transaction.
#[allow(clippy::too_many_arguments)]
pub fn build_add_moderator_proven_tx(
    contract_state: &[u8],
    contract_address: [u8; 32],
    persona_sk: [u8; 32],
    moderator_path: &[(Fr, bool)],
    target_leaf: [u8; 32],
    member_path: &[(Fr, bool)],
    auth_pub: [u8; 32],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    let prototype = add_moderator_prototype(
        contract_state,
        contract_address,
        persona_sk,
        moderator_path,
        target_leaf,
        member_path,
        auth_pub,
    )?;
    crate::tx::assemble_proven_tx(
        prototype,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}
