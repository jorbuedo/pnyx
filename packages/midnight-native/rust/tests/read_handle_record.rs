//! Who holds a name — the read that unblocks handle resolution.
//!
//! `identity.compact` lost its `names` map when handles became one contract per name, and
//! `identity::name_owner` has errored ever since. This is the replacement, read straight off a handle
//! contract's own state.
//!
//! ⚠️ **A record is not a resolution.** `owner` is one half of the bidirectional rule; the identity side
//! is a second read the caller makes. These tests pin what the handle contract says and nothing more.

use std::fs;
use std::path::PathBuf;

use midnight_native::handle::{
    handle_record, read_op, BANNED_SLOT, BURNED_SLOT, NAME_SLOT, OWNER_SLOT, PAYMENT_SLOT,
};

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn field(json: &str, key: &str) -> String {
    let needle = format!("\"{key}\"");
    let start = json
        .find(&needle)
        .and_then(|i| json[i..].find(':').map(|j| i + j + 1))
        .expect("key");
    let rest = json[start..].trim_start();
    match rest.strip_prefix('"') {
        Some(quoted) => quoted[..quoted.find('"').expect("closing quote")].to_string(),
        None => rest[..rest.find([',', '\n', '}']).expect("delimiter")]
            .trim()
            .to_string(),
    }
}

fn bytes32(json: &str, key: &str) -> [u8; 32] {
    hex::decode(field(json, key))
        .expect("hex")
        .try_into()
        .expect("32 bytes")
}

fn inputs() -> String {
    fs::read_to_string(repo_path("fixtures/handle.inputs.json")).expect("read handle.inputs.json")
}

#[test]
fn an_unbound_shell_reports_no_owner() {
    let state =
        fs::read(repo_path("fixtures/handle_unbound.contract_state")).expect("read unbound state");
    let record = handle_record(&state).expect("read record");
    let json = inputs();
    assert_eq!(record.name, bytes32(&json, "name"), "the sealed name");
    assert_eq!(
        record.payment,
        bytes32(&json, "payment"),
        "the sealed payment contract"
    );
    // ⚠️ `None`, not 32 zero bytes. A shell exists from the moment it is deployed and `bind` is a
    // separate transaction, so "deployed and unclaimed" is a common state — and reporting it as an
    // all-zero commitment invites a caller to compare a real `C` against it.
    assert_eq!(record.owner, None, "an unbound shell has no owner");
    assert!(!record.banned);
    assert!(!record.burned);
}

#[test]
fn a_bound_handle_reports_the_holders_commitment() {
    let state =
        fs::read(repo_path("fixtures/handle_bound.contract_state")).expect("read bound state");
    let record = handle_record(&state).expect("read record");
    let json = inputs();
    assert_eq!(
        record.owner,
        Some(bytes32(&json, "c")),
        "the owner is the claimant's C"
    );
    assert!(!record.banned);
    assert!(!record.burned);
}

#[test]
fn the_dispatcher_reports_a_record_as_json() {
    let state =
        fs::read(repo_path("fixtures/handle_bound.contract_state")).expect("read bound state");
    let json = read_op("handle:record", &state, &[]).expect("handle:record");
    assert!(json.contains("\"banned\":false"), "got {json}");
    assert!(
        json.contains(&format!("\"owner\":\"{}\"", field(&inputs(), "c"))),
        "got {json}"
    );
}

/// `null`, not `"0000…"`. The difference is what stops a caller comparing a commitment against nothing.
#[test]
fn the_dispatcher_reports_an_unbound_shell_as_a_null_owner() {
    let state =
        fs::read(repo_path("fixtures/handle_unbound.contract_state")).expect("read unbound state");
    let json = read_op("handle:record", &state, &[]).expect("handle:record");
    assert!(json.contains("\"owner\":null"), "got {json}");
}

#[test]
fn an_unknown_handle_op_is_refused() {
    let state =
        fs::read(repo_path("fixtures/handle_bound.contract_state")).expect("read bound state");
    assert!(read_op("handle:nope", &state, &[]).is_err());
}

#[test]
fn a_malformed_state_is_refused_rather_than_guessed() {
    assert!(handle_record(&[1u8, 2, 3]).is_err());
}

/// Slots are positional and this read has no proving oracle behind it — a wrong slot would return a
/// confident answer about the wrong field, which is worse than an error.
#[test]
fn handle_slots_match_the_compiled_contract() {
    let info = repo_path("../../../contract/managed/handle/compiler/contract-info.json");
    let Ok(json) = fs::read_to_string(&info) else {
        eprintln!(
            "SKIP slot check: {} is missing — run `bun run compile:contract`",
            info.display()
        );
        return;
    };
    let ledger = json
        .split("\"ledger\"")
        .nth(1)
        .expect("contract-info.json has a ledger section");
    // The entry's own `index`, not its position among `"name"` matches: a field's *type* carries named
    // members too, which is what made an earlier version of this check read `prices` as slot 19.
    let slot_of = |wanted: &str| -> usize {
        let at = ledger
            .find(&format!("\"{wanted}\""))
            .unwrap_or_else(|| panic!("no `{wanted}` field"));
        let after = &ledger[at..];
        let index_at = after
            .find("\"index\"")
            .expect("a ledger entry carries its own index");
        after[index_at..]
            .split(':')
            .nth(1)
            .and_then(|rest| rest.trim().split([',', '}', '\n']).next())
            .and_then(|n| n.trim().parse().ok())
            .expect("parse the index")
    };
    assert_eq!(slot_of("name"), NAME_SLOT as usize, "NAME_SLOT moved");
    assert_eq!(
        slot_of("payment"),
        PAYMENT_SLOT as usize,
        "PAYMENT_SLOT moved"
    );
    assert_eq!(slot_of("owner"), OWNER_SLOT as usize, "OWNER_SLOT moved");
    assert_eq!(slot_of("banned"), BANNED_SLOT as usize, "BANNED_SLOT moved");
    assert_eq!(slot_of("burned"), BURNED_SLOT as usize, "BURNED_SLOT moved");
}

/// The same read against **live chain state**, which is the only thing that can catch a fixture that was
/// generated wrongly and then asserted against itself.
///
/// ```sh
/// PNYX_HANDLE_STATE=/path/to/handle.contract_state \
///   cargo test --test read_handle_record -- --nocapture live
/// ```
#[test]
fn live_handle_state_reports_its_holder() {
    let Ok(path) = std::env::var("PNYX_HANDLE_STATE") else {
        eprintln!("SKIP: set PNYX_HANDLE_STATE to a live handle contract state blob");
        return;
    };
    let state = fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let record = handle_record(&state).expect("read record from live state");
    let text: String = record
        .name
        .iter()
        .take_while(|b| **b != 0)
        .map(|b| *b as char)
        .collect();
    println!(
        "name={text:?} owner={:?} banned={} burned={}",
        record.owner.map(hex::encode),
        record.banned,
        record.burned
    );
    assert!(!text.is_empty(), "a deployed handle has a sealed name");
}
