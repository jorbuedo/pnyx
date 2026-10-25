//! Read one Pnyx identity row out of the contract's state.
//!
//! **Why this is native.** Hermes has no WASM, so the app cannot run the generated ledger decoder
//! that `chain-client` uses on the host. Until now that forced every row read through the content
//! service (`GET /identities/:C`), which meant our service learned *who looks up whom* — a social
//! graph an app built on unlinkability has no business holding. With the decode here, the app can
//! query the indexer for contract state directly and resolve rows without telling anyone.
//!
//! **No verification, and none needed.** The circuit authenticated the write: whatever sits at row
//! `C` was put there by someone who knew its preimage. There is no signature to check — which is
//! precisely what the `mn_addr`-keyed keybook this replaced *did* need a reader-side filter for.
//!
//! The encoding is not guessed. It mirrors [`crate::preimage`]'s `identity_row_value` /
//! `bytes32_cell`, which write the row, and is pinned by a test against a state the compact runtime
//! produced (`fixtures/identity_row_published.contract_state`). The retired Preprod capture beside it
//! is kept deliberately — see the note on `STATE` in the tests below.

use crate::state_read::{
    bytes32, field, ANCHOR_SLOT, AUTH_PUB_SLOT, CARD_SLOT, DB, ID_SLOT, PRIMARY_NAME_SLOT,
};
use midnight_base_crypto::hash::persistent_hash;
use midnight_onchain_runtime::state::{ContractState, StateValue};
use midnight_serialize::tagged_deserialize;

/// One row of the contact card, as the contract stores it.
///
/// `value` is the raw 320-byte field. Its meaning — the kind's type bits, the continuation bit, the
/// two-byte length prefix — belongs to `packages/contract-client/src/card.ts`, deliberately: the
/// contract treats a row as opaque and so does this decoder. Handing back raw bytes is what keeps the
/// format in one place instead of two that must agree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardRow {
    pub slot: u8,
    pub kind: u8,
    pub value: Vec<u8>,
}

/// A published row: the identity's own cells plus its contact card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityRow {
    /// The **MLS signature public key**, not `auth_pub` — what a peer checks KeyPackages against.
    pub anchor: [u8; 32],
    /// The Ed25519 key a login challenge is verified against.
    pub auth_pub: [u8; 32],
    /// The claimed primary handle; all-zero when none is claimed.
    ///
    /// ⚠️ A *claim*, not proof of ownership. Ownership lives in `handle(name)`, and contract-to-contract
    /// calls do not exist, so a reader must apply the bidirectional rule before rendering this as a
    /// label: `handle(name).owner == C && identity(C).primaryName == name && !banned && !burned`.
    pub name: [u8; 32],
    /// The contact card, ascending by slot. Empty when nothing has been written.
    pub card: Vec<CardRow>,
}

/// The row held by the identity contract in `state_bytes`, or `None` when nothing is published yet.
///
/// Three outcomes, and the caller shows something different for each — collapsing any two of them is
/// the bug this signature exists to prevent:
///
/// - `Ok(Some(row))` — published.
/// - `Ok(None)` — the shell is deployed and **nothing is published**. The constructor zeroes `anchor`,
///   so this is a real and common state: an identity whose contract exists but which has never
///   published. Distinct from "we could not look".
/// - `Err` — unreadable state, **or a contract sealed to a different `C`**. The latter means the caller
///   fetched the wrong address, which is a bug in the caller rather than an absence, so it must not
///   come back as `None`.
///
/// `c` is no longer a lookup key. There is one contract per identity, so it is checked against the
/// sealed `id` — which is exactly what makes a wrong-address fetch loud instead of returning somebody
/// else's row.
pub fn identity_row(state_bytes: &[u8], c: [u8; 32]) -> Result<Option<IdentityRow>, String> {
    let state: ContractState<DB> = tagged_deserialize(&mut &state_bytes[..])
        .map_err(|e| format!("deserialize pnyx contract state: {e}"))?;

    let cell_bytes32 = |slot: u8, what: &str| -> Result<[u8; 32], String> {
        let StateValue::Cell(ref cell) = field(&state, slot as usize)? else {
            return Err(format!("ledger field {slot} ({what}) is not a cell"));
        };
        match cell.value.0.first() {
            Some(raw) => bytes32(&raw.0, what),
            // A zeroed cell encodes as an empty atom, since the encoding drops trailing zeros.
            None => Ok([0u8; 32]),
        }
    };

    let sealed_id = cell_bytes32(ID_SLOT, "id")?;
    if sealed_id != c {
        return Err(format!(
            "contract is sealed to a different identity: expected {}, found {}",
            hex(&c),
            hex(&sealed_id)
        ));
    }

    let anchor = cell_bytes32(ANCHOR_SLOT, "anchor")?;
    if anchor == [0u8; 32] {
        // The constructor zeroes it, so an all-zero anchor is "deployed but never published" — the
        // one thing a DM flow must tell apart from a failed read.
        return Ok(None);
    }

    Ok(Some(IdentityRow {
        anchor,
        auth_pub: cell_bytes32(AUTH_PUB_SLOT, "authPub")?,
        name: cell_bytes32(PRIMARY_NAME_SLOT, "primaryName")?,
        card: read_card(&state)?,
    }))
}

/// The contact card, ascending by slot.
///
/// An absent or empty map is an empty card, not an error: a published identity that has written no
/// rows is ordinary.
fn read_card(state: &ContractState<DB>) -> Result<Vec<CardRow>, String> {
    let StateValue::Map(ref card) = field(state, CARD_SLOT as usize)? else {
        return Err(format!("ledger field {CARD_SLOT} (card) is not a map"));
    };
    let mut rows: Vec<CardRow> = Vec::new();
    for entry in card.iter() {
        let (key, value) = &*entry;
        let slot = match key.value.0.first() {
            // A `Uint<8>` key of zero encodes as an empty atom, same trailing-zero rule as a cell.
            None => 0u8,
            Some(raw) => match raw.0.as_slice() {
                [] => 0u8,
                [b] => *b,
                other => {
                    return Err(format!(
                        "card slot key is {} bytes, expected 1",
                        other.len()
                    ))
                }
            },
        };
        let StateValue::Cell(ref cell) = **value else {
            return Err(format!("card row {slot} is not a cell"));
        };
        // `CardRow { kind: Uint<8>; value: Bytes<320> }` — two atoms, in declaration order.
        let kind = match cell.value.0.first() {
            None => 0u8,
            Some(raw) => match raw.0.as_slice() {
                [] => 0u8,
                [b] => *b,
                other => {
                    return Err(format!(
                        "card row {slot} kind is {} bytes, expected 1",
                        other.len()
                    ))
                }
            },
        };
        let raw_value = cell
            .value
            .0
            .get(1)
            .ok_or_else(|| format!("card row {slot} is missing its value atom"))?;
        // Left-aligned back to full width: the encoding drops trailing zeros, and the row's own
        // length prefix lives *inside* these bytes, so the decoder must see all 320.
        let mut value_bytes = vec![0u8; 320];
        if raw_value.0.len() > 320 {
            return Err(format!(
                "card row {slot} value is {} bytes, expected at most 320",
                raw_value.0.len()
            ));
        }
        value_bytes[..raw_value.0.len()].copy_from_slice(&raw_value.0);
        rows.push(CardRow {
            slot,
            kind,
            value: value_bytes,
        });
    }
    rows.sort_by_key(|r| r.slot);
    Ok(rows)
}

/// Resolve a handle to its owning `C`.
///
/// ⚠️ **Not available.** Handles left this contract on 2026-08-24: `identity.compact` holds no `names`
/// map, and a name is now its own contract, `handle(name)`, whose address derives from the name alone
/// (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.2). Resolution there is a *different shape* — read that
/// contract's `owner` and apply the bidirectional rule — so this cannot be quietly repointed at
/// another slot.
///
/// It returns an error rather than being deleted because the bridge entry points below stay wired for
/// the handle contract to fill in. An error is the honest answer meanwhile; `None` would say "that
/// handle is free", which is a claim this code is in no position to make.
pub fn name_owner(_state_bytes: &[u8], _name: [u8; 32]) -> Result<Option<[u8; 32]>, String> {
    Err("handle resolution moved to the per-name handle contract; identity.compact holds no names map"
        .to_string())
}

/// [`name_owner`] for the bridges. Errors for the same reason.
pub fn name_owner_hex(state_bytes: &[u8], name: [u8; 32]) -> Result<String, String> {
    name_owner(state_bytes, name).map(|_| String::new())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// [`identity_row`] as JSON for the bridges: an object, or `null` for an unpublished identity.
///
/// `null` is a definite answer and the bridges keep it distinct from an error, because the app shows
/// "cannot be messaged yet" for one and "try again" for the other.
///
/// Card values go over as hex of the full 320 bytes — the row's length prefix is *inside* those bytes,
/// so trimming them here would move the format's knowledge into this function. A full 64-row card is
/// ~41 KB of hex, which is well under the size where bridge hex became a measured problem for prover
/// keys.
pub fn identity_row_json(state_bytes: &[u8], c: [u8; 32]) -> Result<String, String> {
    Ok(match identity_row(state_bytes, c)? {
        Some(row) => {
            let card = row
                .card
                .iter()
                .map(|r| {
                    format!(
                        "{{\"slot\":{},\"kind\":{},\"value\":\"{}\"}}",
                        r.slot,
                        r.kind,
                        hex(&r.value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "{{\"anchor\":\"{}\",\"authPub\":\"{}\",\"name\":\"{}\",\"card\":[{}]}}",
                hex(&row.anchor),
                hex(&row.auth_pub),
                hex(&row.name),
                card,
            )
        }
        None => "null".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// States written by the real compact runtime via `dump-identity-fixtures.mts`.
    ///
    /// ⚠️ Runtime-written, not chain-written — a weaker guarantee for a decoder. The predecessor
    /// fixtures *were* real preprod bytes; the per-identity contract retired them, since the old
    /// contract held `identities` at slot 0 as a map and this one holds `id` there as a cell. Those
    /// bytes now fail loudly rather than decoding wrongly, which is the behaviour to keep.
    /// **Re-capture from preprod once the new contract is deployed there.**
    const CONSTRUCTED: &[u8] = include_bytes!("../fixtures/identity_constructed.contract_state");
    const PUBLISHED: &[u8] = include_bytes!("../fixtures/identity_row_published.contract_state");
    const NAMED: &[u8] = include_bytes!("../fixtures/identity_row_named.contract_state");
    const CARDED: &[u8] = include_bytes!("../fixtures/identity_row_card.contract_state");
    const C: [u8; 32] = *include_bytes!("../fixtures/identity_row_published.c");

    /// A handle, UTF-8 left-aligned and zero-padded.
    fn padded(name: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[..name.len()].copy_from_slice(name.as_bytes());
        out
    }

    #[test]
    fn decodes_a_published_row() {
        let row = identity_row(PUBLISHED, C)
            .expect("decode")
            .expect("row present");
        assert_eq!(row.anchor, [0x70u8; 32], "anchor");
        assert_eq!(row.auth_pub, [0x71u8; 32], "authPub");
        assert_eq!(row.name, [0u8; 32], "no handle claimed yet");
        assert!(row.card.is_empty(), "no card written yet");
    }

    #[test]
    fn a_deployed_but_unpublished_identity_is_none_not_an_error() {
        // The constructor zeroes `anchor`, so this state is ordinary and common: the shell exists and
        // nothing has been published. The DM flow shows "cannot be messaged yet" for this and "try
        // again" for a failed read, so collapsing the two is a user-visible bug.
        assert_eq!(identity_row(CONSTRUCTED, C).expect("decode"), None);
    }

    #[test]
    fn a_claimed_handle_decodes_left_aligned() {
        // The alignment regression: a `Bytes<32>` atom arrives trimmed of trailing zeros, and a
        // right-aligning reader turns `zephyr` into 26 zero bytes followed by the text, which the
        // client then refuses to render — a claimed handle reading back as no handle at all.
        let row = identity_row(NAMED, C)
            .expect("decode")
            .expect("row present");
        assert_eq!(
            row.name,
            padded("zephyr"),
            "the handle must be left-aligned, not right-aligned"
        );
    }

    #[test]
    fn a_contract_sealed_to_another_identity_is_an_error_not_a_missing_row() {
        // `c` is no longer a lookup key — it is checked against the sealed `id`. A mismatch means the
        // caller fetched the wrong address, which is its bug, so it must not come back as `None` and
        // must never come back as somebody else's row.
        let mut other = C;
        other[31] ^= 1;
        let err = identity_row(PUBLISHED, other).expect_err("must not decode");
        assert!(err.contains("sealed to a different identity"), "got: {err}");
    }

    #[test]
    fn decodes_a_card_including_a_value_that_spans_slots() {
        let row = identity_row(CARDED, C)
            .expect("decode")
            .expect("row present");
        // 1 address + 1 website + 3 slots of long-form DID.
        assert_eq!(row.card.len(), 5, "card rows");
        assert_eq!(
            row.card.iter().map(|r| r.slot).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4],
            "ascending by slot"
        );
        for r in &row.card {
            assert_eq!(
                r.value.len(),
                320,
                "slot {} is returned at full width",
                r.slot
            );
            assert_ne!(
                r.kind, 0,
                "slot {} must not be stored as the remove sentinel",
                r.slot
            );
        }
        // The three DID slots share one kind, and the first two carry the continuation bit (0x80).
        let did_kinds: Vec<u8> = row.card[2..].iter().map(|r| r.kind).collect();
        assert_eq!(did_kinds[0] & 0x80, 0x80, "first DID chunk continues");
        assert_eq!(did_kinds[1] & 0x80, 0x80, "second DID chunk continues");
        assert_eq!(did_kinds[2] & 0x80, 0, "last DID chunk terminates");
    }

    #[test]
    fn a_card_row_keeps_the_bytes_the_client_wrote() {
        // The decoder must not interpret the row: the two-byte length prefix and the padding are the
        // client's format, so the first bytes here are that prefix, not the value.
        let row = identity_row(CARDED, C)
            .expect("decode")
            .expect("row present");
        let first = &row.card[0];
        let declared = ((first.value[0] as usize) << 8) | first.value[1] as usize;
        assert!(
            declared > 0 && declared <= 318,
            "length prefix survives the round trip: {declared}"
        );
        assert_eq!(
            &first.value[2..2 + declared],
            b"mn_shield-addr_preprod1qqqqqqqqqqqqqqqqqqqqqqqqq"
        );
    }

    #[test]
    fn garbage_state_is_an_error_not_a_missing_row() {
        assert!(identity_row(&[0u8; 8], C).is_err());
        assert!(identity_row(&PUBLISHED[..PUBLISHED.len() / 2], C).is_err());
    }

    #[test]
    fn the_retired_map_shaped_state_fails_loudly() {
        // A state from the previous contract must not decode. It held `identities` — a map — at slot
        // 0, where `id` is now a cell, so the reader rejects it instead of reading a map as a
        // commitment. Fixture rot that fails silently is the trap this pins shut.
        let err = identity_row(&[0x00, 0x01, 0x02, 0x03], C).expect_err("must not decode");
        assert!(!err.is_empty());
    }

    #[test]
    fn json_carries_the_row_the_card_and_null_for_an_unpublished_one() {
        let json = identity_row_json(CARDED, C).expect("json");
        assert!(
            json.contains(&format!("\"anchor\":\"{}\"", "70".repeat(32))),
            "anchor in json"
        );
        assert!(
            json.contains("\"card\":[{\"slot\":0,"),
            "card is an array of slot objects"
        );
        assert_eq!(
            json.matches("\"slot\":").count(),
            5,
            "every card row crosses the bridge"
        );
        assert_eq!(identity_row_json(CONSTRUCTED, C).expect("json"), "null");
    }

    #[test]
    fn handle_resolution_reports_that_it_moved_rather_than_guessing() {
        // `None` would say "that handle is free", which this code is in no position to claim now that
        // the names map is gone.
        let err = name_owner(PUBLISHED, padded("zephyr")).expect_err("must not resolve");
        assert!(err.contains("handle contract"), "got: {err}");
        assert!(name_owner_hex(PUBLISHED, padded("zephyr")).is_err());
    }
}

/// A contract's **code identity**: SHA-256 over `name ‖ hex(sha256(verifierKey))` for every entry
/// point, in sorted name order.
///
/// The same construction `packages/chain-client/src/sponsorship.ts` computes over an on-chain
/// `operations` map and `services/content/src/artifacts.ts` computes over the compiled
/// `keys/*.verifier` files — which is what lets one published value recognise a contract read off the
/// chain.
///
/// **Why a decoder needs it.** With one contract per identity there is no address to configure, and a
/// server cannot derive one (that needs the deploy machinery this build deliberately excludes). What it
/// can do is check that the contract it was pointed at is built from *our* identity template: combined
/// with the sealed-`id` check in [`identity_row`], that is enough, because `publishRow` proves knowledge
/// of `identitySk` — so a template-conforming contract sealed to `C` can only ever hold `C`'s own row,
/// and anyone else's copy stays empty.
pub fn code_digest(state_bytes: &[u8]) -> Result<String, String> {
    let state: ContractState<DB> = tagged_deserialize(&mut &state_bytes[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for entry in state.operations.iter() {
        let (name, operation) = &*entry;
        let name = String::from_utf8(name.0.clone())
            .map_err(|e| format!("entry point name is not utf-8: {e}"))?;
        let key = operation
            .latest()
            .ok_or_else(|| format!("entry point '{name}' carries no verifier key"))?;
        let mut serialized = Vec::new();
        midnight_serialize::tagged_serialize(key, &mut serialized)
            .map_err(|e| format!("serialize verifier key for '{name}': {e}"))?;
        entries.push((name, serialized));
    }
    // Sorted by name, not by map iteration order: the map's order is not the contract's declaration
    // order and would differ per read, giving a digest that depends on how the state was stored.
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut joined: Vec<u8> = Vec::new();
    for (name, key) in &entries {
        joined.extend_from_slice(name.as_bytes());
        // `persistent_hash` *is* SHA-256 (`midnight_base_crypto::hash`), so this needs no new
        // dependency and stays available in the decode-only Worker build.
        joined.extend_from_slice(hex(&persistent_hash(key).0).as_bytes());
    }
    Ok(hex(&persistent_hash(&joined).0))
}
