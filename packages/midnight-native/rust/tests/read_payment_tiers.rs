//! What the storefront asks the chain: which tiers are free, and what the probed currency costs.
//!
//! Read against the same committed fixture the `claimFreePermit` proving oracle uses, so the two
//! cannot disagree about which tier is open — a UI that offers a tier the circuit will not build for is
//! the failure this pins.

use std::fs;
use std::path::PathBuf;

use midnight_native::payment::{read_op, tier_offers, PRICES_SLOT};

/// NIGHT's colour is 32 zero bytes — not an absence, which is what `None` means to `tier_offers`.
const NIGHT: [u8; 32] = [0u8; 32];

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn free_state() -> Vec<u8> {
    fs::read(repo_path("fixtures/payment_free_t6.contract_state"))
        .expect("read the free-tier state")
}

#[test]
fn tier_six_reads_as_free_and_nothing_else_does() {
    let offers = tier_offers(&free_state(), None).expect("read tiers");
    assert_eq!(offers.len(), 7, "every tier is reported, obtainable or not");
    for offer in &offers {
        assert_eq!(offer.free, offer.tier == 6, "tier {} free flag", offer.tier);
        assert_eq!(
            offer.price, None,
            "no currency was probed, so nothing may carry a price"
        );
    }
}

/// A fresh deployment sells nothing. The storefront has to render that as "unavailable" rather than
/// as a read failure, so it must come back as rows with everything closed.
#[test]
fn a_fresh_deployment_offers_no_tier_at_all() {
    let fresh =
        fs::read(repo_path("fixtures/payment_fresh.contract_state")).expect("read fresh state");
    let offers = tier_offers(&fresh, Some(NIGHT)).expect("read tiers");
    assert_eq!(offers.len(), 7);
    assert!(
        offers.iter().all(|o| !o.free && o.price.is_none()),
        "a fresh contract sells nothing"
    );
}

/// ⚠️ The distinction the type exists for: "accepts no NIGHT" is not "is free". A tier can be both,
/// either or neither, and a storefront that collapsed them would offer a paid tier for nothing.
#[test]
fn free_and_priced_are_independent_answers() {
    let offers = tier_offers(&free_state(), Some(NIGHT)).expect("read tiers");
    let six = offers.iter().find(|o| o.tier == 6).expect("tier 6");
    assert!(six.free, "tier 6 is the open one in this fixture");
    assert_eq!(
        six.price, None,
        "free is not a NIGHT price of zero — that row would remove itself"
    );
}

#[test]
fn the_dispatcher_reports_tiers_as_json() {
    let json = read_op("payment:tiers", &free_state(), &[]).expect("payment:tiers");
    assert!(
        json.contains("{\"tier\":6,\"free\":true,\"price\":null}"),
        "got {json}"
    );
    assert!(
        json.contains("{\"tier\":0,\"free\":false,\"price\":null}"),
        "got {json}"
    );
}

#[test]
fn a_malformed_currency_colour_is_refused_rather_than_padded() {
    let err =
        read_op("payment:tiers", &free_state(), &[1u8; 16]).expect_err("16 bytes is not a colour");
    assert!(
        err.contains("32 bytes"),
        "the error must name the width: {err}"
    );
}

#[test]
fn an_unknown_payment_op_is_refused() {
    assert!(read_op("payment:nope", &free_state(), &[]).is_err());
}

/// Slot indices are positional, and this one has no proving oracle behind it — a read that finds the
/// wrong field returns "nothing is free", which is indistinguishable from a closed namespace.
#[test]
fn payment_prices_slot_matches_the_compiled_contract() {
    let info = repo_path("../../../contract/managed/payment/compiler/contract-info.json");
    let Ok(json) = fs::read_to_string(&info) else {
        eprintln!(
            "SKIP slot check: {} is missing — run `bun run compile:contract`",
            info.display()
        );
        return;
    };
    // ⚠️ Read the entry's own `index`, not its position among `"name"` matches. A ledger field's
    // *type* carries named members too (`Either { is_left, left, right }`), so counting name strings
    // put `prices` at 19 — the identity contract's flat fields are the only reason that ever worked.
    let ledger = json
        .split("\"ledger\"")
        .nth(1)
        .expect("contract-info.json has a ledger section");
    let at = ledger
        .find("\"prices\"")
        .expect("contract-info.json names no `prices` field");
    let after = &ledger[at..];
    let index_at = after
        .find("\"index\"")
        .expect("a ledger entry carries its own index");
    let slot: usize = after[index_at..]
        .split(':')
        .nth(1)
        .and_then(|rest| rest.trim().split([',', '}', '\n']).next())
        .and_then(|n| n.trim().parse().ok())
        .expect("parse the prices index");
    assert_eq!(
        slot, PRICES_SLOT as usize,
        "PRICES_SLOT moved; update payment.rs"
    );
}

/// The same read against **live chain state**, which is the only thing that can catch a fixture that
/// was generated wrongly and then asserted against itself.
///
/// Env-gated because it needs a state blob fetched from an indexer:
///
/// ```sh
/// PNYX_PAYMENT_STATE=/path/to/payment.contract_state \
///   cargo test --test read_payment_tiers -- --nocapture live
/// ```
#[test]
fn live_payment_state_reports_what_was_set_on_chain() {
    let Ok(path) = std::env::var("PNYX_PAYMENT_STATE") else {
        eprintln!("SKIP: set PNYX_PAYMENT_STATE to a live payment contract state blob");
        return;
    };
    let state = fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let offers = tier_offers(&state, Some(NIGHT)).expect("read tiers from live state");
    for offer in &offers {
        println!(
            "tier {} free={} price={:?}",
            offer.tier, offer.free, offer.price
        );
    }
    assert_eq!(offers.len(), 7);
}
