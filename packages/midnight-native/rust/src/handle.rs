//! Reads over `handle.compact`'s state — who holds a name, and whether it still counts.
//!
//! **This is the missing half of handle resolution.** A name's address derives from the name alone, so
//! anyone can find the contract; what nobody could do until now is read what it says. `identity.compact`
//! lost its `names` map when handles became one contract per name (2026-08-24), and the old
//! `identity::name_owner` has been a stub that errors ever since — honest, but it left three things
//! blocked: rendering someone else's name, telling "somebody else holds it" apart from "you already do",
//! and finishing a claim whose `bind` landed and whose `setPrimaryName` did not.
//!
//! ⚠️ **A record is not a resolution.** `owner` is one half of the **bidirectional rule**:
//! `handle(name).owner == C` *and* `identity(C).primaryName` folds to this name, *and* not banned, *and*
//! not burned. This module answers only about the handle contract; the identity side is a second read
//! the caller makes, and `handle.compact` says why — a name pushed at someone who never points back is
//! inert. Returning `owner` alone as "who holds this name" would render a name its holder never claimed.
//!
//! Rides `walletReadOp` under a `handle:` prefix, so it costs no bridge halves — the same grouping
//! `payment:tiers` and the `dust:` reads use.

use midnight_onchain_runtime::state::{ContractState, StateValue};
use midnight_serialize::tagged_deserialize;

use crate::state_read::{bytes32, cell_atom, field, DB};

/// Ledger slots of `handle.compact`, in declaration order.
///
/// Positional, like every slot index in this crate — `handle_slots_match_the_compiled_contract` pins
/// them against the compiled metadata so a moved field is caught there rather than on a device.
pub const NAME_SLOT: u8 = 0;
pub const PAYMENT_SLOT: u8 = 1;
pub const OWNER_SLOT: u8 = 3;
pub const BANNED_SLOT: u8 = 4;
pub const BURNED_SLOT: u8 = 5;

/// What a handle contract holds.
#[derive(Debug, PartialEq, Eq)]
pub struct HandleRecord {
    /// The **canonical** (folded) name, sealed at deploy. A caller compares this to its own encoding to
    /// confirm it fetched the contract it meant to.
    pub name: [u8; 32],
    /// The payment contract this handle's permits must come from, sealed at deploy.
    pub payment: [u8; 32],
    /// The holder's `C`, or `None` when the shell is deployed and unbound.
    ///
    /// ⚠️ All-zero on chain means *nobody has bound it*, which is a real and common state — a shell
    /// exists from the moment it is deployed, and `bind` is a separate transaction. Reported as `None`
    /// rather than as 32 zero bytes so a caller cannot compare a commitment against it by accident.
    pub owner: Option<[u8; 32]>,
    pub banned: bool,
    pub burned: bool,
}

/// A `Boolean` cell. Trailing zeros are dropped, so `false` is an **empty atom** and not a zero byte.
fn read_bool(state: &ContractState<DB>, slot: u8) -> Result<bool, String> {
    let atom = cell_atom(state, slot as usize, 0)?;
    match atom.as_slice() {
        [] => Ok(false),
        [0] => Ok(false),
        [1] => Ok(true),
        other => Err(format!("handle slot {slot} is not a boolean: {other:?}")),
    }
}

fn read_bytes32(state: &ContractState<DB>, slot: u8, what: &str) -> Result<[u8; 32], String> {
    let StateValue::Cell(_) = field(state, slot as usize)? else {
        return Err(format!("handle slot {slot} ({what}) is not a cell"));
    };
    bytes32(&cell_atom(state, slot as usize, 0)?, what)
}

/// Read a handle contract's record out of its serialized state.
pub fn handle_record(state_bytes: &[u8]) -> Result<HandleRecord, String> {
    let state: ContractState<DB> = tagged_deserialize(&mut &state_bytes[..])
        .map_err(|e| format!("deserialize handle state: {e}"))?;
    let owner = read_bytes32(&state, OWNER_SLOT, "owner")?;
    Ok(HandleRecord {
        name: read_bytes32(&state, NAME_SLOT, "name")?,
        payment: read_bytes32(&state, PAYMENT_SLOT, "payment")?,
        owner: if owner == [0u8; 32] {
            None
        } else {
            Some(owner)
        },
        banned: read_bool(&state, BANNED_SLOT)?,
        burned: read_bool(&state, BURNED_SLOT)?,
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `handle:` reads, for the `walletReadOp` dispatcher.
///
/// `owner` is `null` for an unbound shell — a definite answer, and deliberately not 64 zeros, which a
/// caller could compare a commitment against.
pub fn read_op(op: &str, state: &[u8], _arg: &[u8]) -> Result<String, String> {
    match op {
        "handle:record" => {
            let record = handle_record(state)?;
            Ok(format!(
                "{{\"name\":\"{}\",\"payment\":\"{}\",\"owner\":{},\"banned\":{},\"burned\":{}}}",
                hex(&record.name),
                hex(&record.payment),
                match record.owner {
                    Some(owner) => format!("\"{}\"", hex(&owner)),
                    None => "null".to_string(),
                },
                record.banned,
                record.burned,
            ))
        }
        other => Err(format!("unknown handle read op: {other}")),
    }
}
