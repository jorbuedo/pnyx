//! Shared helpers for walking a deserialized contract state.
//!
//! Small but not obvious: the encoding drops *trailing* zero bytes, so a `Bytes<32>` field
//! legitimately arrives shorter and [`bytes32`] left-aligns it back — a rule worth having in exactly
//! one place rather than re-derived per reader.

use midnight_onchain_runtime::state::{ContractState, StateValue};
use midnight_storage::DefaultDB;

pub type DB = DefaultDB;

/// Ledger slots of `identity.compact`, in declaration order.
///
/// **Slot indices are positional and move when a ledger field is added or removed.** That has bitten
/// twice: `identities` was 13 until `dmKeybook` was deleted, and the stale value failed on device as
/// `transcript rejected by runtime: index out of bounds in idx: 13 >= 13` — with the *proof* stage
/// blamed, several layers from the cause. It moved again, 12 → 0, when identity data left the forum
/// contract. `identity_slots_match_the_compiled_contract` (tests/) pins these against the generated
/// contract metadata so the next move is caught there rather than on a device.
///
/// The whole layout changed on 2026-08-24: the contract is now **one deploy per identity**
/// (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.1), so the row is four top-level cells plus the contact
/// card, and there is no `identities` map to look a row up in — the address *is* the identity.
/// `names` is gone entirely; handles move to a per-name contract.
///
/// `id` — `C`, sealed at deploy. Reading it is how a caller confirms it fetched the right contract.
pub const ID_SLOT: u8 = 0;
/// `anchor` — the MLS signature public key a DM resolves to.
pub const ANCHOR_SLOT: u8 = 1;
/// `authPub` — the key a login challenge is verified against.
pub const AUTH_PUB_SLOT: u8 = 2;
/// `primaryName` — the claimed handle; all-zero for none.
pub const PRIMARY_NAME_SLOT: u8 = 3;
/// `card` — the contact card, `Map<Uint<8>, CardRow>`.
pub const CARD_SLOT: u8 = 4;

/// One ledger field by slot index. Slots are positional — see [`IDENTITIES_SLOT`] on what happens
/// when a ledger field is added or removed.
pub fn field(state: &ContractState<DB>, idx: usize) -> Result<StateValue<DB>, String> {
    match state.data.get_ref() {
        StateValue::Array(a) => a
            .get(idx)
            .map(|v| v.clone())
            .ok_or_else(|| format!("ledger field {idx} missing")),
        _ => Err("top-level contract state is not an array".to_string()),
    }
}

/// One atom of a `Cell`-valued ledger field.
pub fn cell_atom(state: &ContractState<DB>, idx: usize, atom: usize) -> Result<Vec<u8>, String> {
    match field(state, idx)? {
        StateValue::Cell(ref c) => Ok(c
            .value
            .0
            .get(atom)
            .ok_or_else(|| format!("field {idx} atom {atom} missing"))?
            .0
            .clone()),
        _ => Err(format!("ledger field {idx} is not a cell")),
    }
}

/// The value of a counter cell (`Counter` / `Uint`) at `idx`.
///
/// The encoding is little-endian with trailing zero bytes dropped, so a fresh counter is an **empty
/// atom** rather than a zero byte — which is why this cannot reuse [`bytes32`], whose rule is the
/// opposite alignment.
///
/// Reads use this to learn a value the *chain* holds; a circuit that must also bake the counter into
/// a transcript reads it through `preimage.rs`'s `read_counter_cell`, which additionally returns the
/// alignment so a `popeq` result matches the stored cell byte-for-byte.
pub fn counter(state: &ContractState<DB>, idx: usize) -> Result<u64, String> {
    let atom = cell_atom(state, idx, 0)?;
    if atom.len() > 8 {
        return Err(format!(
            "counter at {idx} is {} bytes, expected at most 8",
            atom.len()
        ));
    }
    let mut le = [0u8; 8];
    le[..atom.len()].copy_from_slice(&atom);
    Ok(u64::from_le_bytes(le))
}

/// A `Bytes<32>` atom back to its full width.
///
/// **Left-aligned**: the runtime stores these trimmed of *trailing* zeros, so the significant bytes
/// are the leading ones. This right-aligned them until 2026-08-13, which was invisible while every
/// field read here was either full width (`anchor`, `authPub`) or empty (`name`, before handles
/// existed) — the two cases where the two alignments agree. A claimed handle is the first partially
/// filled value to reach it, and right-aligning turned `quartzfox` into 23 zero bytes followed by
/// the text, which `decodeHandle` then correctly refused to render.
///
/// The direction is not inferred: `preimage::claim_name_prototype` reads a row's existing name,
/// rebuilds it and proves against the compiled circuit, which only succeeds if the significant bytes
/// come first.
pub fn bytes32(atom: &[u8], what: &str) -> Result<[u8; 32], String> {
    if atom.len() > 32 {
        return Err(format!(
            "{what} is {} bytes, expected at most 32",
            atom.len()
        ));
    }
    let mut out = [0u8; 32];
    out[..atom.len()].copy_from_slice(atom);
    Ok(out)
}
