//! Reading a circle contract's identity from its state, without any Merkle machinery.
//!
//! **Why this is separate from [`crate::circle`].** That module answers membership questions, which
//! need `midnight-transient-crypto`'s tree hashing — a dependency the Worker build deliberately does
//! not link, since it would pull the whole transient-crypto tree in to answer one question. Reading a
//! sealed cell needs none of it, so it lives here and both hosts can call it.
//!
//! **What it is for.** A circle's address is derived from `(circleId, isOpen, founder)`, and
//! `circleId` is a public function of the content-plane id — so anyone can deploy a *well-formed*
//! circle contract for someone else's circle with themselves as founder, at a different address.
//! Reading the sealed id back is how a host confirms the contract it was handed is the one that
//! content circle's id implies, rather than a valid impostor.

use midnight_onchain_runtime::state::{ContractState, StateValue};

use crate::state_read::{bytes32, field, DB};

/// `circleId` in `circle.compact`'s ledger order: 0 circleId, 1 isOpen, 2 members, 3 moderators.
///
/// Positional, like every slot constant in this crate — a ledger field added above it moves it.
pub const CIRCLE_ID_SLOT: u8 = 0;

/// The `circleId` this contract was sealed to at deploy.
pub fn sealed_circle_id(state_bytes: &[u8]) -> Result<[u8; 32], String> {
    let state: ContractState<DB> = midnight_serialize::tagged_deserialize(&mut &state_bytes[..])
        .map_err(|e| format!("deserialize circle contract state: {e}"))?;
    let StateValue::Cell(ref cell) = field(&state, CIRCLE_ID_SLOT as usize)? else {
        return Err(format!(
            "ledger field {CIRCLE_ID_SLOT} (circleId) is not a cell"
        ));
    };
    match cell.value.0.first() {
        Some(raw) => bytes32(&raw.0, "circleId"),
        // A zeroed cell encodes as an empty atom — the encoding drops trailing zeros — and a circle
        // sealed to all-zero is not a circle any content id derives to, so this stays an honest read
        // rather than an error.
        None => Ok([0u8; 32]),
    }
}
