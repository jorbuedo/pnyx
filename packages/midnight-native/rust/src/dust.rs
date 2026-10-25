//! DUST on the device — the state that lets a phone pay its own Midnight fee.
//!
//! Fees are DUST and nothing else (`feeToken()` is a token *kind* with no raw bytes), so a wallet that
//! cannot hold and spend DUST cannot pay for anything. Today every Midnight send from this app is the
//! sponsor's to pay. This module is the first half of removing that dependency.
//!
//! **Why this is a port and not an implementation.** `packages/chain-client` already runs the whole DUST
//! lifecycle server-side — register NIGHT for generation, wait for accrual, pay a fee from it, snapshot
//! the synced state, resume from the watermark — against Preprod's 1.2M-event history. So the chain and
//! indexer sides are settled; what is missing is a consumer the phone can run. The TS wallet SDK is not
//! it: Hermes has no WebAssembly, so `@midnight-ntwrk/wallet-sdk` cannot load in-app at all.
//!
//! 🔑 **And the Rust path is strictly better than the one the server takes.** `DustLocalState` exposes
//! *both* sync routes — the full `replay_events` the TS `DustWallet` is limited to, **and** the four
//! collapsed-update methods, which exist in `ledger-v8` (the WASM binding) but in **no `wallet-sdk-*`
//! package**. That asymmetry is the whole reason a first DUST sync costs Lace and Moth over an hour and
//! need not cost us the same: the hours are a property of the SDK's sync strategy, not of the ledger,
//! the indexer or the chain.
//!
//! **Nothing here is new dependency surface.** `midnight-ledger` 8.1.0 is already declared in this
//! crate, and the key derivation (`DustSecretKey::derive_secret_key`) is already used and pinned by a
//! golden vector in `lib.rs`.
//!
//! ## What crosses the bridge
//!
//! Both dispatchers already exist, so this costs **zero** hand-written bridge halves — the same
//! reasoning `txIdentifiers` and `signData` were grouped under (see [`crate::wallet::state_op`]). Op
//! names are prefixed `dust:` so the two subjects cannot collide in one dispatcher.
//!
//! ## Paying a fee needs a proof, and here is what it costs
//!
//! `DustLocalState::spend` yields a `DustSpend<ProofPreimageMarker>` and `Transaction::prove` walks
//! `dust_actions`, so a self-funded transaction **proves a circuit**. That circuit is
//! `midnight/dust/spend`, measured at **K=13** from the `spend.bzkir` the ledger crate ships — about
//! 2.8 MB of prover key, and the K=13 SRS is already fetched for the forum circuits. On the measured
//! curve (K=14 release proving 896 ms on host) that is well under a second on device.
//!
//! ⚠️ **The prover key is not in the crate.** `static/dust/` ships `spend.bzkir`, `spend.zkir` and
//! `spend.verifier`, but for `spend.prover` only a `.sha256` —
//! `996602da7ca386284e656c78ea03e55bffdba29475e6a67965c50de05e13efc2`, upstream path
//! `dust/keys/spend.prover`. Exactly the zswap situation, so it needs the same treatment: mirror it to
//! the artifacts origin (`/dust/spend.prover`) and let `ensureCircuitArtifacts('spend', 'dust')` fetch
//! it. Until then a self-funded send can be built and signed but not proved.
//!
//! ⚠️ **The two collapses do different things.** `collapseGenerationTree` is *local* — it discards the
//! witnesses of leaves already present and leaves `first_free` alone, so it shrinks a synced state.
//! `applyGenerationCollapsedUpdate` takes the indexer's blob and moves `first_free` to `end + 1`, which
//! is what skips a range this wallet never had. Using the first where the second was meant yields a tree
//! that refuses the next insert with `CollapsedIndex`.
//!
//! ⚠️ **A gapped event stream is upstream, not us.** The ledger inserts tree leaves in order, so a
//! stream that skips an index is unreplayable by any wallet — the same crate raises the identical
//! `values inserted non-linearly into … tree` error inside the TS wallet SDK. Preprod's public indexer
//! was observed serving gapped streams from ~17:30 UTC on 2026-08-21, crashing wallet-sdk syncs
//! deterministically. `dust:replayEvents` names that case in its error so nobody debugs this port for it.
//!
//! ⚠️ **The key slot carries the DUST role key** for these ops, not a Zswap one. The bridge parameter is
//! named for its first caller; role 1 is Dust in this wallet's derivation.

use midnight_base_crypto::hash::HashOutput;
use midnight_base_crypto::signatures::Signature;
use midnight_base_crypto::time::Timestamp;
use midnight_ledger::dust::{
    DustGenerationInfo, DustLocalState, DustNullifier, DustPublicKey, DustRegistration,
    DustSecretKey, InitialNonce, QualifiedDustOutput,
};
use midnight_ledger::events::Event;
use midnight_ledger::structure::INITIAL_PARAMETERS;
use midnight_serialize::{tagged_deserialize, tagged_serialize};
// Only the tests serialize directly; the lib goes through the tagged helpers above.
#[cfg(test)]
use midnight_serialize::Serializable;
use midnight_transient_crypto::curve::Fr;
use midnight_transient_crypto::merkle_tree::{
    MerkleTreeCollapsedUpdate, MerkleTreeDigest, TreeInsertionPath,
};

use crate::state_read::DB;

type DustState = DustLocalState<DB>;

fn decode(state_bytes: &[u8]) -> Result<DustState, String> {
    tagged_deserialize(&mut &state_bytes[..]).map_err(|e| format!("deserialize dust state: {e}"))
}

fn encode(state: &DustState) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    tagged_serialize(state, &mut out).map_err(|e| format!("serialize dust state: {e}"))?;
    Ok(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A tagged `MerkleTreeCollapsedUpdate` — what the indexer serves as a ~150-byte blob.
fn decode_update(arg: &[u8]) -> Result<MerkleTreeCollapsedUpdate, String> {
    tagged_deserialize(&mut &arg[..]).map_err(|e| format!("deserialize collapsed update: {e}"))
}

/// `start(u64 LE) ‖ end(u64 LE)` — an inclusive index range to collapse.
fn decode_range(arg: &[u8]) -> Result<(u64, u64), String> {
    if arg.len() != 16 {
        return Err(format!(
            "a collapse range is 16 bytes (two u64 LE), got {}",
            arg.len()
        ));
    }
    let start = u64::from_le_bytes(arg[0..8].try_into().expect("8 bytes"));
    let end = u64::from_le_bytes(arg[8..16].try_into().expect("8 bytes"));
    if end < start {
        // Silently swapping them would collapse a range the caller did not ask for, and a collapsed
        // tree cannot be un-collapsed — the witness data for those leaves is gone.
        return Err(format!(
            "a collapse range must not end before it starts: {start}..{end}"
        ));
    }
    Ok((start, end))
}

/// A unix-seconds `u64 LE`.
///
/// Time is a **parameter**, never read from the host clock here: a DUST balance is a function of time
/// (value accrues towards a cap), so the figure shown to a user and the figure a fee is checked against
/// have to come from the same instant the caller chose.
fn decode_time(arg: &[u8]) -> Result<Timestamp, String> {
    if arg.len() != 8 {
        return Err(format!(
            "a time is 8 bytes (u64 LE unix seconds), got {}",
            arg.len()
        ));
    }
    Ok(Timestamp::from_secs(u64::from_le_bytes(
        arg[0..8].try_into().expect("8 bytes"),
    )))
}

/// One of this wallet's generation entries, as the indexer's `DustGenerationsItem` reports it.
///
/// Wire: `genIndex(u64) ‖ comIndex(u64) ‖ value(u128) ‖ initialValue(u128) ‖ ctime(u64) ‖ seq(u32)
/// ‖ backingNight(32) ‖ dtime(u64)`, all little-endian. Fixed-width because this crate carries no
/// parser and a length-prefixed encoding would add a failure mode a divisibility check already covers.
const GENERATION_RECORD_LEN: usize = 8 + 8 + 16 + 16 + 8 + 4 + 32 + 8;

struct GenerationRecord {
    generation_index: u64,
    commitment_index: u64,
    value: u128,
    initial_value: u128,
    ctime: u64,
    seq: u32,
    backing_night: [u8; 32],
    /// `0` means "never" — `Timestamp::MAX`, which is what a registration that has not been undone
    /// carries (`dust.rs:1111`). A dtime update replaces it with a real instant, after which the
    /// entry stops generating.
    dtime: u64,
}

fn decode_generation(arg: &[u8]) -> Result<GenerationRecord, String> {
    if arg.len() != GENERATION_RECORD_LEN {
        return Err(format!(
            "a generation record is {GENERATION_RECORD_LEN} bytes, got {}",
            arg.len()
        ));
    }
    let u64_at = |at: usize| u64::from_le_bytes(arg[at..at + 8].try_into().expect("8 bytes"));
    let u128_at = |at: usize| u128::from_le_bytes(arg[at..at + 16].try_into().expect("16 bytes"));
    Ok(GenerationRecord {
        generation_index: u64_at(0),
        commitment_index: u64_at(8),
        value: u128_at(16),
        initial_value: u128_at(32),
        ctime: u64_at(48),
        seq: u32::from_le_bytes(arg[56..60].try_into().expect("4 bytes")),
        backing_night: arg[60..92].try_into().expect("32 bytes"),
        dtime: u64_at(92),
    })
}

fn timestamp_or_never(secs: u64) -> Timestamp {
    if secs == 0 {
        Timestamp::MAX
    } else {
        Timestamp::from_secs(secs)
    }
}

/// Every DUST operation that returns a **new state**, behind [`crate::wallet::state_op`].
///
/// An unrecognised op is an error rather than a no-op: returning the state unchanged would read as
/// "nothing arrived" instead of "this build cannot do that".
pub fn state_op(
    op: &str,
    state: &[u8],
    dust_role_key: &[u8; 32],
    arg: &[u8],
) -> Result<Vec<u8>, String> {
    match op {
        // A blank state under the protocol's initial DUST parameters — generation rate, cap and decay.
        // Taken from `INITIAL_PARAMETERS` rather than accepted from the caller: they are consensus
        // values, and a wallet that disagreed with the chain about the rate would compute a balance
        // nobody else agrees with.
        "dust:new" => encode(&DustLocalState::new(INITIAL_PARAMETERS.dust)),
        // The fast sync. Each update is one ~150-byte blob the indexer serves
        // (`midnight:merkle-tree-collapsed-update[v1]`), against the full event replay the TS SDK is
        // limited to.
        "dust:applyGenerationCollapsedUpdate" => {
            let next = decode(state)?
                .apply_generation_collapsed_update(&decode_update(arg)?)
                .map_err(|e| format!("apply dust generation collapsed update: {e:?}"))?;
            encode(&next)
        }
        "dust:applyCommitmentCollapsedUpdate" => {
            let next = decode(state)?
                .apply_commitment_collapsed_update(&decode_update(arg)?)
                .map_err(|e| format!("apply dust commitment collapsed update: {e:?}"))?;
            encode(&next)
        }
        // Collapsing discards the witness data for a range this wallet does not need, which is what
        // keeps a synced state small enough to persist on a phone.
        "dust:collapseGenerationTree" => {
            let (start, end) = decode_range(arg)?;
            let next = decode(state)?
                .collapse_generation_tree(start, end)
                .map_err(|e| format!("collapse dust generation tree: {e:?}"))?;
            encode(&next)
        }
        "dust:collapseCommitmentTree" => {
            let (start, end) = decode_range(arg)?;
            let next = decode(state)?
                .collapse_commitment_tree(start, end)
                .map_err(|e| format!("collapse dust commitment tree: {e:?}"))?;
            encode(&next)
        }
        // **The sync proper.** `replay_events` is upstream's own path and the only one that maintains
        // every invariant at once — generation info, commitments, nullifiers, dtime updates. The
        // collapsed-update ops above are what make it cheap: replay the ranges that matter, skip the
        // rest. That combination is unavailable to the TS SDK, which has replay and nothing else.
        //
        // `arg` is `[len(u32 LE) ‖ tagged event]*`.
        //
        // ⚠️ **Length-framed, because tagged values are NOT self-delimiting.** `tagged_deserialize`
        // requires its input to hold exactly one value and fails with "Not all bytes read … N bytes
        // remaining" when more follows — so a concatenated batch is rejected at the first event. Found
        // on device against 64 real events; a host test over one event, or over garbage, passes either
        // way, which is why `two_framed_events_are_read_as_two` exists.
        "dust:replayEvents" => {
            let mut at = 0usize;
            let mut events: Vec<Event<DB>> = Vec::new();
            while at < arg.len() {
                if arg.len() - at < 4 {
                    return Err(format!(
                        "dust event batch ends mid-length after {} event(s): {} trailing byte(s)",
                        events.len(),
                        arg.len() - at,
                    ));
                }
                let len = u32::from_le_bytes(arg[at..at + 4].try_into().expect("4 bytes")) as usize;
                at += 4;
                // A truncated final event is refused rather than read short: the events behind it are
                // chain history nobody revisits once the watermark has moved past them.
                let end = at
                    .checked_add(len)
                    .filter(|e| *e <= arg.len())
                    .ok_or_else(|| {
                        format!(
                            "dust event {} declares {len} bytes but only {} remain",
                            events.len(),
                            arg.len() - at,
                        )
                    })?;
                let mut frame = &arg[at..end];
                let event: Event<DB> = tagged_deserialize(&mut frame)
                    .map_err(|e| format!("deserialize dust event {}: {e}", events.len()))?;
                events.push(event);
                at = end;
            }
            let next = decode(state)?
                .replay_events(&secret_key(dust_role_key), events.iter())
                .map_err(|e| {
                    let detail = e.to_string();
                    // ⚠️ **A non-linear insertion is an indexer gap, not a defect here.** The ledger
                    // requires tree leaves in order, so a stream that skips an index is unreplayable by
                    // anyone — the same crate raises the identical error inside the TS wallet SDK, and
                    // preprod's public indexer was observed serving gapped streams on 2026-08-21.
                    // Named explicitly because the raw message reads like a local bug and has cost
                    // other wallets a deterministic crash with no explanation.
                    if detail.contains("non-linearly") {
                        format!(
                            "the indexer served a gapped event stream, which no wallet can replay — this is upstream, not a local fault: {detail}"
                        )
                    } else {
                        format!("replay {} dust event(s): {detail}", events.len())
                    }
                })?;
            encode(&next)
        }
        // **One of our own generation entries, and the DUST output it backs.**
        //
        // Three inserts that belong together: the generation info (so the entry generates), its
        // commitment (so a spend has a witness), and the UTxO itself (so it is spendable). Splitting
        // them across ops would let a caller land two of the three and hold a state that reads a
        // balance it cannot spend.
        //
        // ⚠️ **Both trees insert linearly**, so the caller must have advanced each to exactly this
        // index first — with a collapsed update for the leaves in between. That alternation *is* the
        // fast sync: on preprod, collapsing 0..238,130 is one 343-byte blob instead of a quarter of a
        // million leaves.
        // **A dtime update to a leaf already in the tree.**
        //
        // ⚠️ Not an insert. When the NIGHT backing a generation moves, the ledger *replaces* that leaf —
        // `generating_tree.update_from_evidence(path)`, in its own replay branch — and the indexer
        // publishes the evidence as `DustGenerationDtimeUpdateItem.treeInsertionPath`. A rebuild never
        // needs this, because it folds the final dtime into the leaf as it inserts it; an **advance**
        // does, because the leaf is already there with the old time and re-inserting it is refused.
        //
        // Without this, an advance silently drifts from the chain's generation root the moment backing
        // NIGHT moves — which surfaces as a self-funded send refused with `170`, not as a wrong balance.
        // **Drop outputs the chain has already spent.**
        //
        // Not a repair of their value — that needs each successor rebuilt from the spending transaction
        // (`docs/DUST_SPEND_PROOF.md` §196). This is the half that stops the damage: selection can no
        // longer pick a dead output and build a proof the node refuses with `196`, and the balance stops
        // counting DUST this wallet does not have.
        //
        // The argument is concatenated 32-byte nullifiers, in the ledger's own serialization — the same
        // bytes `dust:nullifiers` emitted, handed back after the indexer confirmed them spent.
        "dust:removeUtxos" => {
            const NULLIFIER_BYTES: usize = 32;
            if !arg.len().is_multiple_of(NULLIFIER_BYTES) {
                return Err(format!(
                    "a nullifier list must be a multiple of {NULLIFIER_BYTES} bytes, got {}",
                    arg.len()
                ));
            }
            let mut next = decode(state)?;
            let mut dropped = 0usize;
            for chunk in arg.chunks(NULLIFIER_BYTES) {
                let nullifier = DustNullifier(
                    Fr::from_le_bytes(chunk)
                        .ok_or_else(|| "a nullifier is not a field element".to_string())?,
                );
                // An output we do not hold is not an error: the indexer answers by *prefix*, so a match
                // can belong to another wallet, and a repeated sync will re-offer ones already dropped.
                if let Ok(reduced) = next.remove_utxo(&nullifier) {
                    next = reduced;
                    dropped += 1;
                }
            }
            let _ = dropped;
            encode(&next)
        }
        "dust:applyDtimeUpdate" => {
            let state = decode(state)?;
            let insertion: TreeInsertionPath<DustGenerationInfo> =
                tagged_deserialize(&mut &arg[..])
                    .map_err(|e| format!("deserialize dtime tree insertion path: {e}"))?;
            // Mutated in place rather than rebuilt from parts: `DustLocalState`'s other fields
            // (`first_free` on both trees, the night index, the utxo map) are private, and a struct
            // literal cannot carry them across.
            let mut next = state;
            next.generating_tree = next
                .generating_tree
                .update_from_evidence(insertion)
                .map_err(|e| format!("apply dtime update: {e:?}"))?;
            encode(&next)
        }
        "dust:applyGeneration" => {
            let record = decode_generation(arg)?;
            let sk = secret_key(dust_role_key);
            let owner = DustPublicKey::from(sk.clone());
            let backing = InitialNonce(HashOutput(record.backing_night));
            let state = decode(state)?;

            let state = state
                .insert_generation_info(
                    record.generation_index,
                    DustGenerationInfo {
                        value: record.value,
                        owner,
                        nonce: backing,
                        dtime: timestamp_or_never(record.dtime),
                    },
                    // `Some` is what maps the backing NIGHT into `night_indices`, and that mapping is
                    // what `wallet_balance` and `spend` look the entry up by. `None` would insert a
                    // leaf we could see but never use.
                    Some(backing),
                )
                .map_err(|e| {
                    format!(
                        "insert generation info at {}: {e:?}",
                        record.generation_index
                    )
                })?;

            // ⚠️ **`nonces()`, not `dust_nonce()`.** The ledger derives a **seq-0** nonce from the
            // *public* key and every successor from the secret one —
            // `transient_hash((initial_nonce, seq, if seq == 0 { pk.0 } else { self.0 }))`, `dust.rs`
            // `DustSecretKey::nonces`. `dust_nonce` is only the second of those two forms, so using it
            // for a freshly generated output produced a nonce, and therefore a **commitment**, that the
            // chain does not have. Measured 2026-08-23: our generation-tree root matched the chain's
            // exactly while the commitment root never did, which is precisely this — the generation
            // leaf carries the *initial* nonce and does not depend on the derivation.
            //
            // That was the whole of `Custom error: 170 — InvalidDustSpendProof`. Taking the `seq`-th
            // element of the crate's own iterator keeps both forms right without restating the hash.
            let nonce = sk
                .nonces(backing)
                .nth(record.seq as usize)
                .ok_or_else(|| format!("no dust nonce at seq {}", record.seq))?;

            let utxo = QualifiedDustOutput {
                initial_value: record.initial_value,
                owner,
                nonce,
                seq: record.seq,
                ctime: Timestamp::from_secs(record.ctime),
                backing_night: backing,
                mt_index: record.commitment_index,
            };

            let state = state
                .insert_commitment(record.commitment_index, utxo, true)
                .map_err(|e| format!("insert commitment at {}: {e:?}", record.commitment_index))?;
            let state = state
                .add_utxo(&utxo.nullifier(&sk), &utxo, None)
                .map_err(|e| format!("add dust utxo at {}: {e:?}", record.commitment_index))?;
            encode(&state)
        }
        // Drop outputs whose time-to-live has passed. Separate from a balance read because it *changes*
        // the state: a read that quietly expired outputs would make two identical reads disagree.
        "dust:processTtls" => {
            let _ = dust_role_key;
            encode(&decode(state)?.process_ttls(decode_time(arg)?))
        }
        other => Err(format!("unknown dust state op: {other}")),
    }
}

fn utxo_json(utxo: &QualifiedDustOutput) -> String {
    format!(
        "{{\"initialValue\":\"{}\",\"seq\":{},\"ctime\":{},\"mtIndex\":{},\"backingNight\":\"{}\"}}",
        utxo.initial_value,
        utxo.seq,
        utxo.ctime.to_secs(),
        utxo.mt_index,
        hex(&utxo.backing_night.0 .0),
    )
}

/// `dustRoleKey(32) ‖ register(1) ‖ ttlSecs(u64 LE) ‖ ctimeSecs(u64 LE) ‖ feeMargin(1) ‖ networkId(UTF-8)`
///
/// Fixed-width then the network id as the remainder, so there is one length check and no parser.
/// Registrations live in the intent at segment 1. Segment 0 is the guaranteed segment and an intent
/// placed there is rejected outright (`IntentAtGuaranteedSegmentId`) — the registration's *balance*
/// effect lands at segment 0 regardless, because the ledger books it there itself, and its unshielded
/// offer is *guaranteed* whatever segment the intent sits in.
const REGISTRATION_SEGMENT: u16 = 1;

/// NIGHT, the unshielded native token: 32 zero bytes.
const NIGHT_TOKEN_TYPE: [u8; 32] = [0u8; 32];

const REGISTER_PREFIX_LEN: usize = 32 + 1 + 8 + 8 + 1 + 2;

type RegisterArgs = (
    [u8; 32],
    bool,
    u64,
    u64,
    usize,
    Vec<crate::unshielded::UnshieldedInput>,
    String,
);

/// `dust_role_key(32) ‖ register(1) ‖ ttl(8) ‖ ctime(8) ‖ margin(1) ‖ inputCount(u16 LE) ‖
/// inputs(count × 84) ‖ network_id(rest)`.
///
/// The count is explicit and the network id stays last so both variable parts stay unambiguous with
/// one length field rather than two. Must match `encodeRegisterArg` in `src/wallet-wire.ts`.
fn decode_register(arg: &[u8]) -> Result<RegisterArgs, String> {
    // Strictly greater: the network id must be at least one byte. `''` is not `'undeployed'` — the
    // ledger rejects the empty string outright — so an absent network is caught here rather than by a
    // separate emptiness check, which this makes unreachable.
    if arg.len() <= REGISTER_PREFIX_LEN {
        return Err(format!(
            "a registration arg is {} bytes plus a network id of at least one, got {}",
            REGISTER_PREFIX_LEN,
            arg.len()
        ));
    }
    let dust_role_key: [u8; 32] = arg[0..32].try_into().expect("32 bytes");
    let register = match arg[32] {
        0 => false,
        1 => true,
        other => return Err(format!("register must be 0 or 1, got {other}")),
    };
    let ttl = u64::from_le_bytes(arg[33..41].try_into().expect("8 bytes"));
    let ctime = u64::from_le_bytes(arg[41..49].try_into().expect("8 bytes"));
    let margin = arg[49] as usize;
    let count = u16::from_le_bytes(arg[50..52].try_into().expect("2 bytes")) as usize;
    let packed_len = count
        .checked_mul(crate::unshielded::INPUT_RECORD_LEN)
        .ok_or_else(|| format!("a registration input count of {count} overflows"))?;
    let inputs_end = REGISTER_PREFIX_LEN
        .checked_add(packed_len)
        .ok_or_else(|| format!("a registration input count of {count} overflows"))?;
    // Strictly greater again: the network id still needs at least one byte after the inputs.
    if arg.len() <= inputs_end {
        return Err(format!(
            "a registration arg declaring {count} inputs needs {} bytes plus a network id, got {}",
            inputs_end,
            arg.len()
        ));
    }
    let inputs = crate::unshielded::decode_input_records(&arg[REGISTER_PREFIX_LEN..inputs_end])?;
    let network = std::str::from_utf8(&arg[inputs_end..])
        .map_err(|e| format!("network id is not UTF-8: {e}"))?
        .to_string();
    Ok((dust_role_key, register, ttl, ctime, margin, inputs, network))
}

/// Every DUST **read**, returning JSON, behind [`crate::wallet::read_op`].
pub fn read_op(
    op: &str,
    state: &[u8],
    dust_role_key_slot: &[u8; 32],
    arg: &[u8],
) -> Result<String, String> {
    match op {
        // **The number a fee is paid from, and the number a user is shown.**
        //
        // `initialValue` is DUST at the moment an output was created; the spendable amount at time `t`
        // needs the generation model (rate, cap, the backing NIGHT's generation info). The indexer does
        // that arithmetic only on the Cardano registration path, which is why reading generations
        // by address is not a balance. `wallet_balance` is that model, locally.
        "dust:balance" => {
            let state = decode(state)?;
            let time = decode_time(arg)?;
            Ok(format!(
                "{{\"balance\":\"{}\",\"syncTime\":{},\"utxos\":{}}}",
                state.wallet_balance(time),
                state.sync_time.to_secs(),
                state.utxos().count(),
            ))
        }
        // **Not a read**, but it returns JSON and takes no file paths, so it rides this dispatcher for
        // free — the same grouping-by-return-shape that made `txIdentifiers` cost nothing. A
        // registration needs no circuit and no artifacts, which is exactly why it fits here and the
        // self-funded transfer does not.
        //
        // ⚠️ The key slot carries the **Night** role key: a registration is signed by the key that owns
        // the NIGHT. The dust role key travels in `arg`.
        "dust:register" => {
            let (dust_role_key, register, ttl, ctime, margin, inputs, network) =
                decode_register(arg)?;
            build_dust_registration_tx(
                dust_role_key_slot,
                &dust_role_key,
                &inputs,
                register,
                &network,
                ttl,
                ctime,
                margin,
            )
        }
        // **The roots, so "is our tree the chain's tree?" stops being a guess.**
        //
        // A spend proof commits to these two roots and the node looks its own up under the timestamp the
        // spend declares (`root_history.get(ctime)`); a miss is reported as a bad proof rather than an
        // unknown time. The chain publishes both roots per block (`Block.dustGenerationMerkleTreeRoot`,
        // `Block.dustCommitmentMerkleTreeRoot`), so comparing them decides whether a locally built tree
        // is the chain's or merely plausible. `docs/DUST_SPEND_PROOF.md`.
        //
        // ⚠️ `rehash()` first: `root()` is `None` on a tree whose intermediate hashes were never
        // computed, which is the normal state after inserts. `tagged_serialize` rather than the raw
        // field element, because the indexer prints the tagged 33-byte form and a comparison against a
        // bare 32-byte encoding would report a match as a mismatch.
        "dust:treeRoots" => {
            let state = decode(state)?;
            let root_hex = |tree_root: Option<MerkleTreeDigest>| -> Result<String, String> {
                match tree_root {
                    // `null`, not a zero root: "this tree has no hashes" and "this tree hashes to zero"
                    // are different facts, and the comparison this exists for must not confuse them.
                    None => Ok(String::from("null")),
                    Some(digest) => {
                        let mut out = Vec::new();
                        tagged_serialize(&digest, &mut out)
                            .map_err(|e| format!("serialize merkle root: {e}"))?;
                        Ok(format!("\"{}\"", hex(&out)))
                    }
                }
            };
            let generation = root_hex(state.generating_tree.rehash().root())?;
            let commitment = root_hex(state.commitment_tree.rehash().root())?;
            Ok(format!(
                "{{\"generation\":{generation},\"commitment\":{commitment},\"syncTime\":{}}}",
                state.sync_time.to_secs()
            ))
        }
        // **Every output's nullifier, so the chain can be asked which of them are already spent.**
        //
        // ⚠️ `dust-spent` records what *this app* did; the chain knows what a `harness/` run, another
        // device or a dApp did. A state rebuilt at `seq 0` over an output the chain has retired proves
        // fine and is refused at submit with `196 — DustDoubleSpend`, and its value is counted in a
        // balance that is simply wrong. `Subscription.dustNullifierTransactions` answers by nullifier
        // prefix, and this is where the prefixes come from.
        //
        // ⚠️ The key slot carries the **dust** role key here: a nullifier is derived from the secret,
        // which is also why this cannot be computed on the host side.
        "dust:nullifiers" => {
            let state = decode(state)?;
            let sk = secret_key(dust_role_key_slot);
            // ⚠️ **`as_le_bytes`, not `Serializable::serialize`.** The indexer's field is
            // `nullifierLeBytes` and it means it: 32 little-endian bytes. The ledger's serialization of
            // an `Fr` is 33 — a tag byte and then the value — so asking with that never matches and the
            // chain reports every output as unspent. Measured: `asked: 43, spent: 0` on a wallet the node
            // had just refused twice for spending a retired output.
            let rows: Vec<String> = state
                .utxos()
                .map(|utxo| format!("\"{}\"", hex(&utxo.nullifier(&sk).0.as_le_bytes())))
                .collect();
            Ok(format!("[{}]", rows.join(",")))
        }
        "dust:utxos" => {
            let state = decode(state)?;
            let rows: Vec<String> = state.utxos().map(|u| utxo_json(&u)).collect();
            Ok(format!("[{}]", rows.join(",")))
        }
        other => Err(format!("unknown dust read op: {other}")),
    }
}

/// The DUST public key this role key owns, as 32 bytes — see `crate::dust_public_key_le`.
///
/// Re-exported here so a caller working with DUST state has the address side in the same module; the
/// derivation itself stays where its golden vector lives.
pub fn public_key(dust_role_key: &[u8; 32]) -> [u8; 32] {
    crate::dust_public_key_le(dust_role_key)
}

/// A DUST secret key from the role key, for the spend path.
pub fn secret_key(dust_role_key: &[u8; 32]) -> DustSecretKey {
    DustSecretKey::derive_secret_key(dust_role_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    use midnight_base_crypto::hash::HashOutput;
    use midnight_ledger::dust::{DustGenerationInfo, DustPublicKey, InitialNonce};
    use midnight_transient_crypto::curve::Fr;

    /// Role 1 is Dust in this wallet's derivation; any 32 bytes exercise the same code path.
    const DUST_KEY: [u8; 32] = [3u8; 32];

    /// ⚠️ **A nullifier crosses to the indexer as 32 little-endian bytes, not the ledger's 33.**
    ///
    /// `Subscription.dustNullifierTransactions` takes `nullifierLeBytesPrefixes`, and the ledger's
    /// `Serializable` encoding of an `Fr` is a tag byte plus the value. Asking with that form matches
    /// nothing and the chain reports every output as unspent — measured as `asked: 43, spent: 0` on a
    /// wallet the node had just refused twice for spending a retired output. A silent false negative,
    /// which is the worst shape for this particular question.
    #[test]
    fn a_nullifier_crosses_as_thirty_two_little_endian_bytes() {
        let sk = secret_key(&DUST_KEY);
        let utxo = QualifiedDustOutput {
            initial_value: 5,
            owner: DustPublicKey::from(sk.clone()),
            nonce: Fr::from(7u64),
            seq: 0,
            ctime: Timestamp::from_secs(1_700_000_000),
            backing_night: InitialNonce(HashOutput([1u8; 32])),
            mt_index: 0,
        };
        let nullifier = utxo.nullifier(&sk);

        let le = nullifier.0.as_le_bytes();
        assert_eq!(le.len(), 32, "the indexer's field is 32 bytes");

        let mut tagged = Vec::new();
        Serializable::serialize(&nullifier, &mut tagged).expect("serialize");
        assert_ne!(
            tagged, le,
            "the ledger's own encoding is not what the indexer asks for"
        );

        // And it round-trips, which is what `dust:removeUtxos` relies on.
        assert_eq!(Fr::from_le_bytes(&le).expect("round trip"), nullifier.0);
    }

    /// ⚠️ **The bug that made every self-funded send fail with `170`.**
    ///
    /// A commitment is a function of the nonce, and the ledger derives a **seq-0** nonce from the
    /// *public* key while every successor uses the secret one. `dust_nonce` is only the second form, so
    /// building a fresh output with it produced a commitment the chain does not have — invisible in the
    /// balance, fatal to the proof. Asserted against both forms so a "simplification" back to
    /// `dust_nonce` cannot pass.
    #[test]
    fn a_seq_zero_nonce_comes_from_the_public_key_not_the_secret() {
        let sk = secret_key(&DUST_KEY);
        let backing = InitialNonce(HashOutput([7u8; 32]));

        let ours = sk.nonces(backing).next().expect("a seq-0 nonce");
        let secret_form = midnight_ledger::dust::dust_nonce(&backing, 0, &sk);
        assert_ne!(ours, secret_form, "seq 0 must not use the secret-key form");

        let successor = sk.nonces(backing).nth(1).expect("a seq-1 nonce");
        assert_eq!(
            successor,
            midnight_ledger::dust::dust_nonce(&backing, 1, &sk),
            "seq 1 and above *are* the secret-key form",
        );
    }

    fn json(op: &str, state: &[u8], arg: &[u8]) -> String {
        read_op(op, state, &DUST_KEY, arg).expect(op)
    }

    fn secs(t: u64) -> Vec<u8> {
        t.to_le_bytes().to_vec()
    }

    fn range(start: u64, end: u64) -> Vec<u8> {
        let mut out = start.to_le_bytes().to_vec();
        out.extend_from_slice(&end.to_le_bytes());
        out
    }

    fn fresh() -> Vec<u8> {
        state_op("dust:new", &[], &DUST_KEY, &[]).expect("new")
    }

    /// A state holding one generating NIGHT and the DUST output it backs.
    ///
    /// Built with the crate's own API rather than through the dispatcher: the point is to prove the
    /// *read* reports the generation model, so the fixture must be beyond doubt.
    fn generating(value: u128, ctime: u64) -> Vec<u8> {
        let sk = secret_key(&DUST_KEY);
        let owner = DustPublicKey::from(sk.clone());
        let backing = InitialNonce(HashOutput([7u8; 32]));
        let gen_info = DustGenerationInfo {
            value,
            owner,
            nonce: backing,
            dtime: Timestamp::from_secs(u64::MAX / 2),
        };
        let state = decode(&fresh()).expect("decode");
        let state = state
            .insert_generation_info(0, gen_info, Some(backing))
            .expect("insert generation info");
        let utxo = QualifiedDustOutput {
            initial_value: 0,
            owner,
            nonce: Fr::from(1u64),
            seq: 0,
            ctime: Timestamp::from_secs(ctime),
            backing_night: backing,
            mt_index: 0,
        };
        let state = state
            .add_utxo(&utxo.nullifier(&sk), &utxo, None)
            .expect("add utxo");
        encode(&state).expect("encode")
    }

    /// A `dust:applyGeneration` record. `dtime` 0 means "never", as a live registration carries.
    #[allow(clippy::too_many_arguments)]
    fn generation_record(
        generation_index: u64,
        commitment_index: u64,
        value: u128,
        initial_value: u128,
        ctime: u64,
        seq: u32,
        backing: [u8; 32],
        dtime: u64,
    ) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&generation_index.to_le_bytes());
        out.extend_from_slice(&commitment_index.to_le_bytes());
        out.extend_from_slice(&value.to_le_bytes());
        out.extend_from_slice(&initial_value.to_le_bytes());
        out.extend_from_slice(&ctime.to_le_bytes());
        out.extend_from_slice(&seq.to_le_bytes());
        out.extend_from_slice(&backing);
        out.extend_from_slice(&dtime.to_le_bytes());
        out
    }

    #[test]
    fn applying_our_generation_makes_a_spendable_growing_balance() {
        // The whole sync in miniature, and the property that matters: after the three inserts the
        // entry is in `night_indices`, so `wallet_balance` runs the generation model over it and the
        // figure grows with time. A leaf inserted without its nonce mapping would be visible and
        // unusable, and would read as 0 for ever.
        let state = state_op(
            "dust:applyGeneration",
            &fresh(),
            &DUST_KEY,
            &generation_record(0, 0, 5_000_000_000, 0, 1_700_000_000, 0, [7u8; 32], 0),
        )
        .expect("apply generation");

        let at = |t: u64| -> u128 {
            let text =
                read_op("dust:balance", &state, &DUST_KEY, &t.to_le_bytes()).expect("balance");
            let start = text.find("\"balance\":\"").expect("balance") + 11;
            let rest = &text[start..];
            rest[..rest.find('"').expect("close")]
                .parse()
                .expect("u128")
        };
        assert_eq!(at(1_700_000_000), 0, "nothing has accrued at creation");
        assert!(at(1_700_003_600) > 0, "an hour later there is DUST");
        assert!(
            at(1_700_086_400) > at(1_700_003_600),
            "and more after a day"
        );

        let utxos = read_op("dust:utxos", &state, &DUST_KEY, &[]).expect("utxos");
        assert!(
            utxos.contains("\"mtIndex\":0"),
            "the output must be listed: {utxos}"
        );
    }

    #[test]
    fn a_dtime_in_the_past_stops_generation() {
        // A dtime update marks the backing NIGHT as gone. Treating 0 as "epoch" rather than "never"
        // would silently do this to every live entry, so the sentinel is worth pinning.
        let live = state_op(
            "dust:applyGeneration",
            &fresh(),
            &DUST_KEY,
            &generation_record(0, 0, 5_000_000_000, 0, 1_700_000_000, 0, [7u8; 32], 0),
        )
        .expect("live");
        let dead = state_op(
            "dust:applyGeneration",
            &fresh(),
            &DUST_KEY,
            &generation_record(
                0,
                0,
                5_000_000_000,
                0,
                1_700_000_000,
                0,
                [7u8; 32],
                1_700_000_001,
            ),
        )
        .expect("dead");

        let at = |bytes: &[u8]| -> String {
            read_op(
                "dust:balance",
                bytes,
                &DUST_KEY,
                &1_700_086_400u64.to_le_bytes(),
            )
            .unwrap()
        };
        assert!(
            !at(&live).contains("\"balance\":\"0\""),
            "a live entry accrues: {}",
            at(&live)
        );
        assert!(
            at(&dead).contains("\"balance\":\"0\""),
            "a dead one does not: {}",
            at(&dead)
        );
    }

    #[test]
    fn a_non_linear_generation_insert_is_refused() {
        // Both trees insert linearly. The caller must collapse up to the index first — that alternation
        // is the fast sync, and skipping it must fail rather than produce a tree with a hole.
        let err = state_op(
            "dust:applyGeneration",
            &fresh(),
            &DUST_KEY,
            &generation_record(238_131, 0, 1, 0, 1, 0, [7u8; 32], 0),
        )
        .expect_err("index 238131 into an empty tree");
        assert!(err.contains("insert generation info at 238131"), "{err}");
    }

    #[test]
    fn a_generation_record_of_the_wrong_width_is_refused() {
        let err =
            state_op("dust:applyGeneration", &fresh(), &DUST_KEY, &[0u8; 40]).expect_err("short");
        assert!(
            err.contains("is 92 bytes") || err.contains("bytes, got 40"),
            "{err}"
        );
    }

    #[test]
    fn a_locally_collapsed_index_can_no_longer_be_inserted_into() {
        // ⚠️ **The two collapses are not interchangeable, and this is the trap.**
        // `collapseGenerationTree` is *local*: it throws away the witnesses for leaves already in the
        // tree and does NOT advance `first_free`. So collapsing a range you then insert into fails with
        // `CollapsedIndex` — it is for shrinking a synced state, never for skipping ahead.
        // `applyGenerationCollapsedUpdate` is the one that skips: it comes from the indexer and moves
        // `first_free` to `end + 1`. A sync that used the wrong one gets a tree it cannot insert into.
        let collapsed = state_op(
            "dust:collapseGenerationTree",
            &fresh(),
            &DUST_KEY,
            &range(0, 0),
        )
        .expect("collapse");
        let err = state_op(
            "dust:applyGeneration",
            &collapsed,
            &DUST_KEY,
            &generation_record(0, 0, 1_000, 0, 1_700_000_000, 0, [7u8; 32], 0),
        )
        .expect_err("a collapsed index cannot take a leaf");
        assert!(err.contains("CollapsedIndex"), "{err}");
    }

    #[test]
    fn a_fresh_state_holds_nothing_and_says_so() {
        let state = fresh();
        assert_eq!(
            json("dust:balance", &state, &secs(1_800_000_000)),
            "{\"balance\":\"0\",\"syncTime\":0,\"utxos\":0}",
        );
        assert_eq!(json("dust:utxos", &state, &[]), "[]");
    }

    #[test]
    fn a_state_survives_the_bridge_round_trip() {
        // Every op re-serializes, so a state that did not survive encode/decode would lose the sync
        // watermark on the very first call and silently re-sync from zero.
        let state = fresh();
        let again = encode(&decode(&state).expect("decode")).expect("encode");
        assert_eq!(state, again);
    }

    #[test]
    fn dust_accrues_with_time_from_registered_night() {
        // The whole reason this port exists: `initialValue` is DUST at creation, and the spendable
        // amount at time t needs the generation model. A read that returned `initialValue` would say 0
        // for ever here.
        let state = generating(1_000_000_000, 1_700_000_000);
        let at = |t: u64| -> u128 {
            let text = json("dust:balance", &state, &secs(t));
            let start = text.find("\"balance\":\"").expect("balance") + 11;
            let rest = &text[start..];
            rest[..rest.find('"').expect("close")]
                .parse()
                .expect("u128")
        };

        assert_eq!(at(1_700_000_000), 0, "nothing has accrued at creation");
        let hour = at(1_700_003_600);
        let day = at(1_700_086_400);
        assert!(hour > 0, "DUST must accrue after an hour, got {hour}");
        assert!(day > hour, "and more after a day: {day} vs {hour}");
    }

    #[test]
    fn a_generating_state_reports_its_utxo() {
        let rows = json("dust:utxos", &generating(1_000_000_000, 1_700_000_000), &[]);
        assert!(rows.contains("\"seq\":0"), "{rows}");
        assert!(
            rows.contains(&hex(&[7u8; 32])),
            "the backing night must be named: {rows}"
        );
    }

    #[test]
    fn collapsing_a_tree_keeps_the_state_readable() {
        let state = state_op(
            "dust:collapseCommitmentTree",
            &fresh(),
            &DUST_KEY,
            &range(0, 0),
        )
        .expect("collapse");
        assert_eq!(
            json("dust:balance", &state, &secs(1_800_000_000)),
            "{\"balance\":\"0\",\"syncTime\":0,\"utxos\":0}"
        );
    }

    #[test]
    fn processing_ttls_is_a_state_change_not_a_read() {
        // It drops expired outputs, so it must not hide inside a balance read — two identical reads
        // would then disagree.
        let state = state_op(
            "dust:processTtls",
            &fresh(),
            &DUST_KEY,
            &secs(1_800_000_000),
        )
        .expect("ttls");
        assert!(!state.is_empty(), "a processed state is still a state");
    }

    #[test]
    fn a_backwards_collapse_range_is_refused() {
        // A collapsed tree cannot be un-collapsed: the witness data for those leaves is gone. Swapping
        // the bounds silently would discard a range nobody asked to lose.
        let err = state_op(
            "dust:collapseGenerationTree",
            &fresh(),
            &DUST_KEY,
            &range(9, 4),
        )
        .expect_err("backwards");
        assert!(err.contains("must not end before it starts"), "{err}");
    }

    #[test]
    fn a_malformed_range_is_refused_rather_than_padded() {
        let err = state_op(
            "dust:collapseGenerationTree",
            &fresh(),
            &DUST_KEY,
            &[0u8; 9],
        )
        .expect_err("short");
        assert!(err.contains("16 bytes"), "{err}");
    }

    #[test]
    fn a_malformed_time_is_refused_rather_than_defaulted() {
        // Defaulting to zero would report the balance at the epoch — always 0, and indistinguishable
        // from an empty wallet.
        let err = read_op("dust:balance", &fresh(), &DUST_KEY, &[0u8; 4]).expect_err("short time");
        assert!(err.contains("8 bytes"), "{err}");
    }

    #[test]
    fn garbage_is_not_mistaken_for_a_state() {
        let err = read_op("dust:balance", &[0u8; 8], &DUST_KEY, &secs(1)).expect_err("garbage");
        assert!(err.contains("deserialize dust state"), "{err}");
    }

    #[test]
    fn replaying_no_events_is_a_no_op_rather_than_a_failure() {
        // An empty batch is what a caught-up sync hands over on every tick.
        let state = fresh();
        let same = state_op("dust:replayEvents", &state, &DUST_KEY, &[]).expect("empty batch");
        assert_eq!(same, state);
    }

    #[test]
    fn a_malformed_event_batch_is_refused_and_names_the_index() {
        // A truncated batch must not read as a short one: the missing events are chain history this
        // wallet would then never see, and the watermark would advance past them.
        let err = state_op(
            "dust:replayEvents",
            &fresh(),
            &DUST_KEY,
            &frame(&[&[9u8; 20]]),
        )
        .expect_err("garbage");
        assert!(err.contains("deserialize dust event 0"), "{err}");
    }

    /// `[len(u32 LE) ‖ payload]*` — the batch framing `dust:replayEvents` reads.
    fn frame(payloads: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for payload in payloads {
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(payload);
        }
        out
    }

    #[test]
    fn two_framed_events_are_read_as_two() {
        // ⚠️ **The device found this and no host test had.** Concatenated tagged values are not
        // self-delimiting: `tagged_deserialize` demands its input hold exactly one and fails with
        // "Not all bytes read … N bytes remaining". A batch of 64 real events was rejected at event 0.
        // A single event, or garbage, passes either way — only two *well-formed* frames pin the
        // boundary, so this asserts the reader reaches the SECOND frame.
        let one = b"not really an event, but a frame".as_slice();
        let err = state_op(
            "dust:replayEvents",
            &fresh(),
            &DUST_KEY,
            &frame(&[one, one]),
        )
        .expect_err("payloads are not events");
        assert!(
            err.contains("deserialize dust event 0"),
            "the first frame must be read on its own, not against the whole batch: {err}",
        );
        assert!(
            !err.contains("bytes remaining"),
            "a framing error means the boundary was ignored: {err}",
        );
    }

    #[test]
    fn a_frame_longer_than_the_batch_is_refused() {
        // Reading it short would drop chain history the watermark then skips past.
        let mut bytes = 999u32.to_le_bytes().to_vec();
        bytes.extend_from_slice(b"short");
        let err =
            state_op("dust:replayEvents", &fresh(), &DUST_KEY, &bytes).expect_err("truncated");
        assert!(err.contains("declares 999 bytes"), "{err}");
    }

    #[test]
    fn a_batch_ending_mid_length_is_refused() {
        let err =
            state_op("dust:replayEvents", &fresh(), &DUST_KEY, &[0u8; 3]).expect_err("mid-length");
        assert!(err.contains("ends mid-length"), "{err}");
    }

    /// Role 0 is Night, role 1 Dust — derived rather than pasted so the test is pinned to the wallet.
    fn night_key() -> [u8; 32] {
        [5u8; 32]
    }

    fn registration(register: bool) -> Result<String, String> {
        build_dust_registration_tx(
            &night_key(),
            &DUST_KEY,
            &[],
            register,
            "undeployed",
            1_800_000_000,
            1_700_000_000,
            2,
        )
    }

    #[test]
    fn a_registration_builds_seals_and_authorises_its_own_fee() {
        // ⚠️ Builds and seals — but do not read this as "the offerless shape works". A node **refuses**
        // it: with no offer there is no NIGHT for `generationless_fee_availability` to sum, so a
        // nonzero allowance is `InsufficientDustForRegistrationFee`. Building and being accepted are
        // different checks, and only `registration_offer_tests` covers the second.
        let json = registration(true).expect("build a registration");
        let fee = json
            .split("\"allowFeePayment\":\"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .expect("a fee");
        assert_ne!(
            fee, "0",
            "the registration must authorise enough to cover its own fee"
        );
        assert!(json.contains("\"tx\":\""), "{json}");
    }

    #[test]
    fn the_authorised_amount_covers_the_fee_the_ledger_asks_for() {
        // `allow_fee_payment` is not a policy knob: the ledger credits it to the DUST balance, so a
        // value below the fee leaves the transaction overspent and unacceptable. Re-priced here from
        // the built bytes rather than trusting the builder's own arithmetic.
        use midnight_ledger::structure::{ProofMarker, Transaction, INITIAL_PARAMETERS};
        use midnight_transient_crypto::commitment::PureGeneratorPedersen;

        let json = registration(true).expect("build");
        let tx_hex = json
            .split("\"tx\":\"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .expect("tx");
        let authorised: u128 = json
            .split("\"allowFeePayment\":\"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .expect("fee")
            .parse()
            .expect("u128");

        let bytes: Vec<u8> = (0..tx_hex.len() / 2)
            .map(|i| u8::from_str_radix(&tx_hex[i * 2..i * 2 + 2], 16).expect("hex"))
            .collect();
        let sealed: Transaction<Signature, ProofMarker, PureGeneratorPedersen, DB> =
            tagged_deserialize(&mut &bytes[..]).expect("a sealed registration deserializes");
        let asked = sealed.fees(&INITIAL_PARAMETERS, false).expect("price it");
        assert!(
            authorised >= asked,
            "authorised {authorised} must cover the ledger's {asked}",
        );
    }

    #[test]
    fn the_registration_leaves_no_negative_dust_balance() {
        // The property that makes it self-funding: the authorised amount credits DUST at segment 0 and
        // the fee debits it, so the transaction balances with no spend and no sponsor.
        let json = registration(true).expect("build");
        let tx_hex = json
            .split("\"tx\":\"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .expect("tx");
        let bytes: Vec<u8> = (0..tx_hex.len() / 2)
            .map(|i| u8::from_str_radix(&tx_hex[i * 2..i * 2 + 2], 16).expect("hex"))
            .collect();
        // Sealed, so it deserializes under the bound marker rather than the pre-binding one.
        use midnight_ledger::structure::{ProofMarker, Transaction};
        use midnight_transient_crypto::commitment::PureGeneratorPedersen;
        let sealed: Transaction<Signature, ProofMarker, PureGeneratorPedersen, DB> =
            tagged_deserialize(&mut &bytes[..]).expect("deserialize");
        let balance = sealed.balance(None).expect("balance");
        for ((token, segment), delta) in balance {
            assert!(delta >= 0, "{token:?} at segment {segment} is {delta}");
        }
    }

    #[test]
    fn deregistering_is_the_same_builder_without_the_address() {
        let register = registration(true).expect("register");
        let deregister = registration(false).expect("deregister");
        assert_ne!(
            register, deregister,
            "dropping the dust address must change the transaction"
        );
    }

    fn register_arg(network: &str, register: bool) -> Vec<u8> {
        register_arg_with(network, register, &[])
    }

    fn register_arg_with(
        network: &str,
        register: bool,
        inputs: &[crate::unshielded::UnshieldedInput],
    ) -> Vec<u8> {
        let mut out = DUST_KEY.to_vec();
        out.push(if register { 1 } else { 0 });
        out.extend_from_slice(&1_800_000_000u64.to_le_bytes());
        out.extend_from_slice(&1_700_000_000u64.to_le_bytes());
        out.push(2);
        out.extend_from_slice(&(inputs.len() as u16).to_le_bytes());
        for i in inputs {
            out.extend_from_slice(&i.value.to_le_bytes());
            out.extend_from_slice(&i.token_type);
            out.extend_from_slice(&i.intent_hash);
            out.extend_from_slice(&i.output_no.to_le_bytes());
        }
        out.extend_from_slice(network.as_bytes());
        out
    }

    /// The count frames the inputs, so a wrong one must be caught rather than read into the network id.
    #[test]
    fn a_registration_whose_input_count_overruns_is_refused() {
        let mut arg = register_arg("undeployed", true);
        arg[50] = 9;
        let err =
            crate::wallet::read_op("dust:register", &[], &night_key(), &arg).expect_err("overrun");
        assert!(err.contains("declaring 9 inputs"), "{err}");
    }

    /// Inputs given over the wire must reach the offer, or the device would build the very shape the
    /// node refuses while every host test passed.
    #[test]
    fn inputs_reach_the_offer_through_the_dispatcher() {
        let input = crate::unshielded::UnshieldedInput {
            value: 1_000,
            token_type: [0u8; 32],
            intent_hash: [3u8; 32],
            output_no: 0,
        };
        let with = crate::wallet::read_op(
            "dust:register",
            &[],
            &night_key(),
            &register_arg_with("undeployed", true, &[input]),
        )
        .expect("routed registration with an input");
        let without = crate::wallet::read_op(
            "dust:register",
            &[],
            &night_key(),
            &register_arg("undeployed", true),
        )
        .expect("routed registration without inputs");
        assert_ne!(
            with, without,
            "an input that changed nothing never reached the offer"
        );
    }

    #[test]
    fn the_registration_rides_the_read_dispatcher() {
        // Zero bridge files, so a routing mistake would only show on device. The key slot carries the
        // **Night** key here, not a Zswap or Dust one.
        let json = crate::wallet::read_op(
            "dust:register",
            &[],
            &night_key(),
            &register_arg("undeployed", true),
        )
        .expect("routed registration");
        assert!(json.contains("\"allowFeePayment\":\""), "{json}");
    }

    #[test]
    fn a_registration_without_a_network_is_refused() {
        // `''` is not `'undeployed'` — the ledger rejects the empty string — so the length guard is
        // what catches it, and it is deliberately strict rather than `>=`.
        let err =
            crate::wallet::read_op("dust:register", &[], &night_key(), &register_arg("", true))
                .expect_err("no network");
        assert!(err.contains("at least one"), "{err}");
    }

    #[test]
    fn a_truncated_registration_arg_is_refused() {
        let err = crate::wallet::read_op("dust:register", &[], &night_key(), &[0u8; 20])
            .expect_err("short");
        assert!(err.contains("plus a network id"), "{err}");
    }

    #[test]
    fn a_register_flag_that_is_neither_zero_nor_one_is_refused() {
        // It decides whether the wallet registers or *deregisters*, so a coerced value would silently
        // do the opposite of what was asked.
        let mut arg = register_arg("undeployed", true);
        arg[32] = 7;
        let err =
            crate::wallet::read_op("dust:register", &[], &night_key(), &arg).expect_err("bad flag");
        assert!(err.contains("must be 0 or 1"), "{err}");
    }

    #[test]
    fn an_unknown_op_is_an_error_not_a_no_op() {
        assert!(state_op("dust:wat", &fresh(), &DUST_KEY, &[]).is_err());
        assert!(read_op("dust:wat", &fresh(), &DUST_KEY, &[]).is_err());
    }

    #[test]
    fn a_collapsed_update_that_is_not_one_is_refused() {
        let err = state_op(
            "dust:applyGenerationCollapsedUpdate",
            &fresh(),
            &DUST_KEY,
            &[0u8; 16],
        )
        .expect_err("not an update");
        assert!(err.contains("deserialize collapsed update"), "{err}");
    }

    #[test]
    fn the_dust_ops_route_through_the_wallet_dispatchers() {
        // The bridge cost of this module is zero because both dispatchers already exist. If the
        // prefix routing broke, every op would fail as "unknown wallet state op" on device only.
        let state = crate::wallet::state_op("dust:new", &[], &DUST_KEY, &[]).expect("routed new");
        assert_eq!(state, fresh());
        let read = crate::wallet::read_op("dust:balance", &state, &DUST_KEY, &secs(1_800_000_000))
            .expect("routed read");
        assert!(read.contains("\"balance\":\"0\""), "{read}");
    }

    #[test]
    fn a_non_dust_unknown_op_still_reports_the_wallet_dispatcher() {
        // The prefix guard must not swallow everything else.
        let err = crate::wallet::state_op("nonsense", &[], &DUST_KEY, &[]).expect_err("unknown");
        assert!(err.contains("unknown wallet state op"), "{err}");
    }
}

/// Register this wallet's NIGHT for DUST generation, so it can pay its own fees.
///
/// ## Why this is the small one
///
/// `DustActions::prove` proves only `spends` — registrations are cloned straight through — so a
/// registration needs **no circuit, no prover key and no SRS**. It is a signed declaration, not a ZK
/// statement. And it registers *the night key*, not each UTxO, so all NIGHT that key owns begins
/// generating at once.
///
/// ## `allow_fee_payment` is load-bearing, not a policy knob
///
/// The ledger's own balance computation **credits** `allow_fee_payment` to the DUST balance at segment
/// 0 (`verify.rs`, the `dust_reg` loop). That is the protocol's bootstrap: the registration authorises
/// its own fee to be paid out of the DUST its NIGHT projects to generate, which is how a wallet with no
/// DUST yet can ever get any. `chain-client`'s `ensureDust` relies on exactly this server-side.
///
/// So the field must cover this transaction's own fee, and it is computed rather than guessed. The
/// circularity that made a transfer's fee awkward does not bite here: `allow_fee_payment` is a
/// fixed-width `u128`, so changing its *value* does not change the transaction's size, and one pricing
/// pass is exact.
///
/// ## It funds itself, so it seals
///
/// Nothing else needs to be added to it — no sponsor, and no synced DUST state either. It is therefore
/// sealed rather than left unbound, and submittable as it stands.
///
/// NIGHT spent straight back to its own owner, so the ledger can see it.
///
/// Not a transfer: one output, to the same address, for the whole input value. It exists only because
/// `generationless_fee_availability` reads `guaranteed_unshielded_offer.inputs` and nothing else, so
/// NIGHT that merely *sits* in the wallet backs no fee allowance at all.
///
/// `None` for an empty input list rather than an empty offer — an `UnshieldedOffer` with no inputs and
/// no outputs is not the same thing as no offer, and only one of them is what a deregistration wants.
fn self_spend_offer(
    night_key: &midnight_base_crypto::signatures::SigningKey,
    inputs: &[crate::unshielded::UnshieldedInput],
) -> Result<
    (
        Option<midnight_ledger::structure::UnshieldedOffer<Signature, DB>>,
        Vec<midnight_base_crypto::signatures::SigningKey>,
    ),
    String,
> {
    use midnight_coin_structure::coin::{UnshieldedTokenType, UserAddress};
    use midnight_ledger::structure::{IntentHash, UnshieldedOffer, UtxoOutput, UtxoSpend};

    if inputs.is_empty() {
        return Ok((None, vec![]));
    }
    // A non-NIGHT input would fold its value into the NIGHT output — the same mistake
    // `crate::unshielded` guards, and worth guarding separately because here the caller picks the
    // UTxOs and nothing downstream re-checks the token.
    if let Some(wrong) = inputs.iter().find(|i| i.token_type != NIGHT_TOKEN_TYPE) {
        return Err(format!(
            "a registration can only spend NIGHT, but an input is token {}",
            wrong
                .token_type
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ));
    }

    let owner = night_key.verifying_key();
    let token = UnshieldedTokenType(midnight_base_crypto::hash::HashOutput(NIGHT_TOKEN_TYPE));
    let total: u128 = inputs
        .iter()
        .try_fold(0u128, |acc, i| acc.checked_add(i.value))
        .ok_or_else(|| "the registration's NIGHT inputs overflow u128".to_string())?;

    let mut spends: Vec<UtxoSpend> = inputs
        .iter()
        .map(|i| UtxoSpend {
            value: i.value,
            owner: owner.clone(),
            type_: token,
            intent_hash: IntentHash(midnight_base_crypto::hash::HashOutput(i.intent_hash)),
            output_no: i.output_no,
        })
        .collect();
    spends.sort();
    if spends.windows(2).any(|w| w[0] == w[1]) {
        return Err("the same output was given twice as a registration input".into());
    }

    let outputs = vec![UtxoOutput {
        value: total,
        owner: UserAddress::from(owner.clone()),
        type_: token,
    }];
    // One key per input, in input order: `Intent::sign` zips them and rejects any mismatch.
    let keys = spends.iter().map(|_| night_key.clone()).collect();
    Ok((
        Some(UnshieldedOffer::<Signature, DB> {
            inputs: spends.into(),
            outputs: outputs.into(),
            signatures: vec![].into(),
        }),
        keys,
    ))
}

/// ## ⚠️ The NIGHT backing the allowance must be spent **by this intent**
///
/// This is the part that is not guessable from the field's name, and getting it wrong makes every
/// registration fail identically. The ledger's check is `generationless_fee_availability`, and it sums
/// only over **`parent_intent.guaranteed_unshielded_offer.inputs`** — NIGHT owned by the registering
/// key, spent *inside this very intent*, that is not already generating. A registration carrying no
/// offer therefore sums an empty iterator, and any nonzero `allow_fee_payment` is refused as
/// `InsufficientDustForRegistrationFee` (`Custom error: 173`) **no matter how much NIGHT the wallet
/// holds** — confirmed on preprod against a wallet with 6,500 NIGHT and one with none.
///
/// So `night_inputs` are spent back to their own owner: a self-transfer whose only purpose is to put
/// the NIGHT where the ledger looks for it.
///
/// **Guaranteed, not fallible.** That is forced — the ledger reads only the guaranteed offer — and it
/// collides with the rule in `crate::unshielded` that NIGHT inputs belong in the fallible segment,
/// where four of them saturate the 15 ms time-to-dismiss. A registration therefore takes few inputs by
/// nature; it needs enough projection for one fee, not the whole balance.
///
/// ⚠️ **The projected DUST still has to exist.** Per input the ledger allows
/// `clamp(dt × value × generation_decay_rate, 0, value × night_dust_ratio)` where `dt` is
/// `ctime − utxo.ctime`, so **freshly received NIGHT projects almost nothing** and a just-funded wallet
/// still has to wait. That is the chain's design — inversely proportional to balance — and no wallet
/// shortens it.
///
/// Pass `register: false` to **deregister**, which is the same transaction with the binding removed.
pub fn build_dust_registration_tx(
    night_role_key: &[u8; 32],
    dust_role_key: &[u8; 32],
    night_inputs: &[crate::unshielded::UnshieldedInput],
    register: bool,
    network_id: &str,
    ttl_secs: u64,
    ctime_secs: u64,
    fee_margin: usize,
) -> Result<String, String> {
    use midnight_base_crypto::signatures::SigningKey;
    use midnight_ledger::dust::DustActions;
    use midnight_ledger::structure::{
        Intent, ProofPreimageMarker, Transaction, INITIAL_PARAMETERS,
    };
    use midnight_onchain_runtime::cost_model::INITIAL_COST_MODEL;
    use midnight_storage::arena::Sp;
    use midnight_storage::storage::HashMap as StorageHashMap;
    use midnight_transient_crypto::commitment::PedersenRandomness;
    use rand::rngs::OsRng;

    type UnprovenIntent = Intent<Signature, ProofPreimageMarker, PedersenRandomness, DB>;
    type UnprovenTx = Transaction<Signature, ProofPreimageMarker, PedersenRandomness, DB>;

    let night_key = SigningKey::from_bytes(night_role_key)
        .map_err(|_| "malformed night role key".to_string())?;
    let dust_sk = secret_key(dust_role_key);
    let dust_address = if register {
        Some(Sp::new(DustPublicKey::from(dust_sk)))
    } else {
        None
    };
    let ctime = Timestamp::from_secs(ctime_secs);
    let (night_offer, offer_keys) = self_spend_offer(&night_key, night_inputs)?;

    let build = |allow_fee_payment: u128| -> Result<UnprovenIntent, String> {
        let registration = DustRegistration::<Signature, DB> {
            night_key: night_key.verifying_key(),
            dust_address: dust_address.clone(),
            allow_fee_payment,
            signature: None,
        };
        let intent: UnprovenIntent = UnprovenIntent::new(
            &mut OsRng,
            night_offer.clone(),
            None,
            vec![],
            vec![],
            vec![],
            Some(DustActions::<Signature, ProofPreimageMarker, DB> {
                spends: vec![].into(),
                registrations: vec![registration].into(),
                ctime,
            }),
            Timestamp::from_secs(ttl_secs),
        );
        // Third slot signs the *guaranteed* offer, fifth the registration. The registration's is
        // verified against its own `night_key`; a mismatch in either is `IntentSignatureKeyMismatch`.
        intent
            .sign(
                &mut OsRng,
                REGISTRATION_SEGMENT,
                &offer_keys,
                &[],
                &[night_key.clone()],
            )
            .map_err(|e| format!("sign the dust registration: {e:?}"))
    };

    // Pass one prices it. `allow_fee_payment` is a fixed-width u128, so its value does not change the
    // transaction's size and this figure is exact for pass two.
    let priced = UnprovenTx::from_intents(
        network_id.to_string(),
        StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(REGISTRATION_SEGMENT, build(0)?),
    );
    let fee = priced
        .fees_with_margin(&INITIAL_PARAMETERS, fee_margin)
        .map_err(|e| format!("price the registration's fee: {e:?}"))?;

    let tx = UnprovenTx::from_intents(
        network_id.to_string(),
        StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(REGISTRATION_SEGMENT, build(fee)?),
    );

    // Nothing to prove: `DustActions::prove` touches only spends, and there are none. `NoCircuits`
    // refuses loudly if that ever stops being true, which is the behaviour we want.
    let proven =
        futures::executor::block_on(tx.prove(crate::unshielded::NoCircuits, &INITIAL_COST_MODEL))
            .map_err(|e| format!("prove the registration: {e:?}"))?;
    let sealed = proven.seal(OsRng);

    let mut bytes = Vec::new();
    tagged_serialize(&sealed, &mut bytes)
        .map_err(|e| format!("serialize the registration: {e}"))?;
    Ok(format!(
        "{{\"tx\":\"{}\",\"allowFeePayment\":\"{fee}\"}}",
        hex(&bytes)
    ))
}

#[cfg(test)]
mod registration_offer_tests {
    use super::*;
    use crate::unshielded::UnshieldedInput;
    use midnight_serialize::tagged_deserialize;
    use std::ops::Deref;

    type SealedTx = midnight_ledger::structure::Transaction<
        Signature,
        midnight_ledger::structure::ProofMarker,
        midnight_transient_crypto::commitment::PureGeneratorPedersen,
        DB,
    >;

    fn key(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    fn night(value: u128, output_no: u32) -> UnshieldedInput {
        UnshieldedInput {
            value,
            token_type: NIGHT_TOKEN_TYPE,
            intent_hash: [output_no as u8 + 1; 32],
            output_no,
        }
    }

    fn built(inputs: &[UnshieldedInput]) -> SealedTx {
        let json =
            build_dust_registration_tx(&key(7), &key(9), inputs, true, "preprod", 3_600, 0, 10)
                .expect("build the registration");
        let tx_hex = json
            .split("\"tx\":\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        let bytes = (0..tx_hex.len() / 2)
            .map(|i| u8::from_str_radix(&tx_hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect::<Vec<u8>>();
        tagged_deserialize(&mut &bytes[..]).expect("deserialize the registration")
    }

    fn intent(
        tx: &SealedTx,
    ) -> midnight_ledger::structure::Intent<
        Signature,
        midnight_ledger::structure::ProofMarker,
        midnight_transient_crypto::commitment::PureGeneratorPedersen,
        DB,
    > {
        match tx {
            midnight_ledger::structure::Transaction::Standard(std) => std
                .intents
                .get(&REGISTRATION_SEGMENT)
                .expect("the registration intent")
                .deref()
                .clone(),
            _ => panic!("expected a standard transaction"),
        }
    }

    /// The whole point of the offer: without it `generationless_fee_availability` sums nothing and the
    /// node refuses the registration as `InsufficientDustForRegistrationFee`, whatever the wallet holds.
    #[test]
    fn the_night_lands_in_the_guaranteed_offer() {
        let tx = built(&[night(4_000, 0), night(2_500, 1)]);
        let intent = intent(&tx);

        let offer = intent
            .guaranteed_unshielded_offer
            .as_ref()
            .expect("the NIGHT must be in the *guaranteed* offer — the ledger reads no other");
        assert_eq!(offer.inputs.iter().count(), 2);
        assert!(
            intent.fallible_unshielded_offer.is_none(),
            "a fallible offer would be invisible to the fee-availability check"
        );
    }

    /// Spent back to its own owner, whole. A short output would burn the difference to fees.
    #[test]
    fn it_returns_every_input_to_the_same_owner() {
        let tx = built(&[night(4_000, 0), night(2_500, 1)]);
        let offer = intent(&tx)
            .guaranteed_unshielded_offer
            .as_ref()
            .unwrap()
            .deref()
            .clone();

        let outputs: Vec<_> = offer.outputs.iter_deref().cloned().collect();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].value, 6_500);

        let owner = offer.inputs.iter_deref().next().unwrap().owner.clone();
        assert_eq!(
            outputs[0].owner,
            midnight_coin_structure::coin::UserAddress::from(owner)
        );
    }

    /// One signature per input, or the ledger rejects the whole intent as
    /// `InputsSignaturesLengthMismatch` — the count is not something `Intent::sign` infers.
    #[test]
    fn every_input_is_signed() {
        let tx = built(&[night(1, 0), night(2, 1), night(3, 2)]);
        let offer = intent(&tx)
            .guaranteed_unshielded_offer
            .as_ref()
            .unwrap()
            .deref()
            .clone();
        assert_eq!(offer.signatures.iter().count(), offer.inputs.iter().count());
    }

    /// A deregistration spends nothing, and an offer with no inputs is not the same as no offer.
    #[test]
    fn no_inputs_means_no_offer_at_all() {
        let tx = built(&[]);
        assert!(intent(&tx).guaranteed_unshielded_offer.is_none());
    }

    #[test]
    fn it_refuses_a_non_night_input() {
        let mut wrong = night(1_000, 0);
        wrong.token_type = [9u8; 32];
        let err =
            build_dust_registration_tx(&key(7), &key(9), &[wrong], true, "preprod", 3_600, 0, 10)
                .expect_err("a non-NIGHT input must be refused");
        assert!(err.contains("only spend NIGHT"), "{err}");
    }

    #[test]
    fn it_refuses_the_same_output_twice() {
        let err = build_dust_registration_tx(
            &key(7),
            &key(9),
            &[night(1, 0), night(1, 0)],
            true,
            "preprod",
            3_600,
            0,
            10,
        )
        .expect_err("a duplicate input must be refused");
        assert!(err.contains("twice"), "{err}");
    }
}
