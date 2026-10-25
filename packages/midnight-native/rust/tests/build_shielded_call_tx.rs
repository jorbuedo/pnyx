//! A contract call that moves shielded value, built and proven end to end on the host.
//!
//! ⚠️ **What this asserts is the rule that actually decides acceptance.** `Transaction::well_formed`
//! collects the transcript's `claimed_shielded_receives`, `claimed_nullifiers` and
//! `claimed_shielded_spends` and requires each to be matched by a real offer element in the **same
//! intent and the same phase** (`midnight-ledger` 8.1.0 `verify.rs`). Running that check needs a
//! `LedgerState` with the contract deployed, which a host test does not have — so the comparison is
//! re-implemented here against the built transaction. That is deliberate: this is the one class of
//! defect a circuit proof cannot catch, because a transcript with no offer is internally consistent
//! and proves perfectly well. The unshielded mint path found that out at the cost of one on-chain
//! submission.
//!
//! The transcript and the Zswap local state both come from the **compactc-generated driver** running
//! on the real `compact-runtime` in Node (`scripts/dump-driver-transcripts.mts`), so nothing about
//! the circuit's half is invented here.

use midnight_ledger::structure::{ContractAction, Transaction};
use midnight_native::compact::compact_op;
use midnight_native::wallet::{state_insert_coin, state_new, Coin};
use midnight_serialize::tagged_deserialize;
use midnight_storage::DefaultDB;
use serde_json::{json, Value as J};
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

type DB = DefaultDB;

const SEGMENT: u16 = 1;
/// The wallet that funds the purchase. Any key works — nothing on chain has seen it.
const ROLE_KEY: [u8; 32] = [0x2b; 32];

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("hex"))
        .collect()
}

fn bytes32(s: &str) -> [u8; 32] {
    <[u8; 32]>::try_from(unhex(s).as_slice()).expect("32 bytes")
}

/// The one circuit in the repo that reaches Zswap.
fn fixture() -> J {
    let raw = fs::read_to_string(repo_path("fixtures/driver.transcripts.json"))
        .expect("read driver.transcripts.json — regenerate with dump-driver-transcripts.mts");
    let all: Vec<J> = serde_json::from_str(&raw).expect("the transcripts fixture is JSON");
    all.into_iter()
        .find(|e| e["entryPoint"] == "buyPermitShielded")
        .expect("the fixture carries buyPermitShielded")
}

struct Artifacts {
    zkir: PathBuf,
    prover: PathBuf,
    verifier: PathBuf,
    zswap_dir: PathBuf,
    params_dir: PathBuf,
}

/// The contract circuit's three files, plus the ledger's own protocol circuits and the SRS.
///
/// ⚠️ `params_dir` is a **directory**: a shielded call proves at three different Ks, so the
/// single-file SRS the plain call path takes would serve the wrong one to two of them.
fn artifacts() -> Option<Artifacts> {
    let managed = repo_path("../../../contract/managed/payment");
    let cache = PathBuf::from(std::env::var("HOME").ok()?).join(".cache/midnight/zk-params");
    let zswap_dir = cache.join("zswap/9");
    if !zswap_dir.join("spend.prover").exists() {
        return None;
    }
    let zkir = managed.join("zkir/buyPermitShielded.bzkir");
    if !zkir.exists() {
        return None;
    }
    Some(Artifacts {
        zkir,
        prover: managed.join("keys/buyPermitShielded.prover"),
        verifier: managed.join("keys/buyPermitShielded.verifier"),
        zswap_dir,
        params_dir: cache,
    })
}

/// A wallet holding one coin of `color`, worth `value`.
///
/// Inserted rather than scanned for, because this test has no chain: `insert_coin` places it at
/// `first_free`, which is index 0 on a blank state, and that is the index its spend proves against.
fn wallet_with(color: [u8; 32], value: u128) -> Vec<u8> {
    let blank = state_new().expect("new wallet state");
    state_insert_coin(
        &blank,
        &ROLE_KEY,
        &Coin {
            nonce: [0x5e; 32],
            color,
            value,
        },
    )
    .expect("insert the funding coin")
}

fn build(fixture: &J, wallet_state: &[u8], a: &Artifacts) -> Result<J, String> {
    let out = compact_op(
        "tx.buildShielded",
        &json!({
            "state": fixture["state"],
            "address": fixture["contractAddress"],
            "entryPoint": fixture["entryPoint"],
            "program": fixture["program"],
            "privateTranscriptOutputs": fixture["privateTranscriptOutputs"],
            "input": fixture["input"],
            "output": fixture["output"],
            "zswap": fixture["zswap"],
            "walletState": hex(wallet_state),
            "zswapRoleKey": hex(&ROLE_KEY),
            "zkirPath": a.zkir.to_str().expect("utf-8 path"),
            "proverKeyPath": a.prover.to_str().expect("utf-8 path"),
            "verifierKeyPath": a.verifier.to_str().expect("utf-8 path"),
            "zswapArtifactDir": a.zswap_dir.to_str().expect("utf-8 path"),
            "paramsDir": a.params_dir.to_str().expect("utf-8 path"),
            "networkId": "undeployed",
            "ttlSecs": 4_102_444_800u64,
            "segment": SEGMENT,
        })
        .to_string(),
    )?;
    Ok(serde_json::from_str(&out).expect("the bridge answers JSON"))
}

/// ⚠️ **The one that decides 60(a).** Everything else in the shielded item waits on this shape being
/// right, and "it proved" is not evidence that it is.
#[test]
fn a_shielded_call_carries_an_offer_that_satisfies_its_own_transcript() {
    let fixture = fixture();
    let paid = &fixture["zswap"]["inputs"][0];
    let color = bytes32(paid["color"].as_str().expect("a colour"));
    let value: u128 = paid["value"].as_str().expect("a value").parse().expect("u128");

    // More than the purchase costs, so the change branch runs too — a wallet that only ever funds
    // exactly would never exercise it, and change is where our own money goes.
    let wallet = wallet_with(color, value + 600);

    let Some(a) = artifacts() else {
        eprintln!("SKIP: contract/managed/payment or the zswap circuits are absent");
        return;
    };

    let started = std::time::Instant::now();
    let built = build(&fixture, &wallet, &a).expect("build the shielded call");
    let tx_bytes = unhex(built["tx"].as_str().expect("a transaction"));
    eprintln!(
        "shielded buyPermitShielded: {} bytes in {} ms",
        tx_bytes.len(),
        started.elapsed().as_millis()
    );

    // The wallet comes back changed, or a second call would select the same note and double-spend.
    assert_ne!(
        built["walletState"].as_str().expect("a wallet state"),
        hex(&wallet),
        "the spent coin must be marked pending in the returned state"
    );

    let tx: Transaction<
        midnight_base_crypto::signatures::Signature,
        midnight_ledger::structure::ProofMarker,
        midnight_transient_crypto::commitment::PedersenRandomness,
        DB,
    > = tagged_deserialize(&mut &tx_bytes[..]).expect("the built transaction deserializes");
    let Transaction::Standard(stx) = tx else {
        panic!("a contract call is a standard transaction")
    };

    // ── The transcript's claims ──────────────────────────────────────────────────────────────
    let intent = stx.intents.get(&SEGMENT).expect("an intent at the call's segment");
    let mut claimed_receives = BTreeSet::new();
    let mut claimed_nullifiers = BTreeSet::new();
    let mut claimed_spends = BTreeSet::new();
    for action in intent.actions.iter() {
        let ContractAction::Call(call) = &*action else {
            continue;
        };
        let transcript = call
            .fallible_transcript
            .as_ref()
            .expect("the call's transcript is in the FALLIBLE slot");
        for c in transcript.effects.claimed_shielded_receives.iter() {
            claimed_receives.insert(hex(&c.0 .0));
        }
        for n in transcript.effects.claimed_nullifiers.iter() {
            claimed_nullifiers.insert(hex(&n.0 .0));
        }
        for c in transcript.effects.claimed_shielded_spends.iter() {
            claimed_spends.insert(hex(&c.0 .0));
        }
    }
    assert!(
        !claimed_receives.is_empty() && !claimed_nullifiers.is_empty() && !claimed_spends.is_empty(),
        "buyPermitShielded claims a receive, a nullifier and a spend — if any is empty the fixture is wrong"
    );

    // ── What the offer actually carries, at the same segment and phase ───────────────────────
    let offer = stx
        .fallible_coins
        .get(&SEGMENT)
        .expect("the offer must be FALLIBLE and at the call's segment — a guaranteed one cannot satisfy a fallible claim");

    let mut contract_commitments = BTreeSet::new();
    let mut contract_nullifiers = BTreeSet::new();
    let mut all_commitments = BTreeSet::new();
    for t in offer.transient.iter() {
        all_commitments.insert(hex(&t.coin_com.0 .0));
        if t.contract_address.is_some() {
            contract_commitments.insert(hex(&t.coin_com.0 .0));
            contract_nullifiers.insert(hex(&t.nullifier.0 .0));
        }
    }
    for o in offer.outputs.iter() {
        all_commitments.insert(hex(&o.coin_com.0 .0));
        if o.contract_address.is_some() {
            contract_commitments.insert(hex(&o.coin_com.0 .0));
        }
    }
    for i in offer.inputs.iter() {
        if i.contract_address.is_some() {
            contract_nullifiers.insert(hex(&i.nullifier.0 .0));
        }
    }

    // The ledger's own three comparisons.
    assert_eq!(
        contract_commitments, claimed_receives,
        "every contract-addressed commitment must be claimed by the transcript, and vice versa"
    );
    assert_eq!(
        contract_nullifiers, claimed_nullifiers,
        "every contract-associated nullifier must be claimed by the transcript, and vice versa"
    );
    assert!(
        claimed_spends.is_subset(&all_commitments),
        "a claimed shielded spend must exist as a commitment in the offer\nclaimed: {claimed_spends:?}\noffer:   {all_commitments:?}"
    );

    // Our own funding is present and is *not* contract-associated — if it were, it would be counted
    // against the transcript's claims and the equality above would have to fail.
    assert_eq!(offer.inputs.len(), 1, "one funding input");
    assert!(
        offer.inputs.iter().all(|i| i.contract_address.is_none()),
        "our funding input belongs to us, not to the contract"
    );
    // Treasury coin plus our change.
    assert_eq!(offer.outputs.len(), 2, "the treasury output and our change");

    // ⚠️ **The circuit mints a permit too, and an unshielded mint has the same rule.**
    // `claimed_unshielded_spends` must be matched by a real `UtxoOutput` in the same intent and
    // phase — the check `assemble_proven_tx_with_mints` exists for, and which a shielded call does
    // not escape just because its shielded half is right.
    let mut claimed_unshielded = 0usize;
    for action in intent.actions.iter() {
        let ContractAction::Call(call) = &*action else {
            continue;
        };
        let transcript = call.fallible_transcript.as_ref().expect("a fallible transcript");
        claimed_unshielded += transcript.effects.claimed_unshielded_spends.iter().count();
    }
    let minted = intent
        .fallible_unshielded_offer
        .as_ref()
        .map_or(0, |o| o.outputs.len());
    assert_eq!(
        minted, claimed_unshielded,
        "the permit this circuit mints needs a matching unshielded output, or the node rejects the \
         whole transaction as an effects-check failure"
    );
}

/// The same circuit, against **live preprod state** rather than the simulator's.
///
/// ⚠️ Worth its own case because the two differ in exactly the way that bites: the fixture's state
/// was built by a simulator in Node, this one was read off the chain at block 2,534,149, and a
/// transcript is bound to the state it ran against.
#[test]
fn the_live_preprod_transcript_builds_too() {
    let raw = match fs::read_to_string(repo_path("fixtures/live_buy_permit_shielded.json")) {
        Ok(raw) => raw,
        Err(_) => {
            eprintln!("SKIP: live_buy_permit_shielded.json absent");
            return;
        }
    };
    let live: J = serde_json::from_str(&raw).expect("the live fixture is JSON");
    let color = bytes32(live["zswap"]["inputs"][0]["color"].as_str().expect("a colour"));
    let value: u128 = live["zswap"]["inputs"][0]["value"]
        .as_str()
        .expect("a value")
        .parse()
        .expect("u128");
    let wallet = wallet_with(color, value + 100_000);

    let Some(a) = artifacts() else {
        eprintln!("SKIP: artifacts absent");
        return;
    };
    let built = build(&live, &wallet, &a).expect("build against live preprod state");
    let bytes = unhex(built["tx"].as_str().expect("a transaction"));
    eprintln!("live preprod buyPermitShielded: {} bytes", bytes.len());
    assert!(bytes.len() > 1000, "a proven shielded call is not small");
}

/// A circuit that spends a shielded coin it did **not** create in the same transaction needs the
/// real commitment tree, not the blank one a transient builds. Refused by name rather than producing
/// an input whose Merkle path proves against a tree the chain does not share.
#[test]
fn a_circuit_input_with_no_matching_output_is_refused() {
    let fixture = fixture();
    let mut broken = fixture.clone();
    // Drop the contract-owned output, leaving its input unpaired.
    broken["zswap"]["outputs"] = json!([fixture["zswap"]["outputs"][1]]);
    let color = bytes32(fixture["zswap"]["inputs"][0]["color"].as_str().expect("a colour"));
    let wallet = wallet_with(color, 10_000);

    let Some(a) = artifacts() else {
        eprintln!("SKIP: artifacts absent");
        return;
    };
    let err = build(&broken, &wallet, &a).expect_err("an unpaired circuit input must be refused");
    assert!(err.contains("did not create in the same transaction"), "got: {err}");
}
