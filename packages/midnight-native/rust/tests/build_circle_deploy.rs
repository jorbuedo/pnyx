//! The native circle-deploy path, checked against the compiled constructor.
//!
//! A circle's address is `SHA-256(tagged_serialize(ContractDeploy))`, so the Rust-built initial state
//! has to equal what `contract.initialState(id, open, founder)` produces — any drift is a different
//! circle, and it would only surface as a join that cannot find its contract. Equality against a state
//! the real compact runtime wrote is the whole oracle here; there is no proof to fall back on, because
//! a constructor is not a circuit.
//!
//! The comparison is per field rather than over the serialized whole: `data`/`operations`/`balance`
//! must match, while the maintenance authority deliberately must **not** (the SDK samples a signing
//! key; circles are immutable). Serialized bytes also carry the storage arena's rc-map, which differs
//! by construction route without the state differing.
//!
//! Artifacts:
//! - `fixtures/circle_deploy.contract_state` + `.inputs.json` — committed; regenerate with
//!   `node --import tsx packages/midnight-native/scripts/dump-circle-deploy.mts`. ⚠️ Derived from the
//!   gitignored `contract/managed`, so a contract recompile invalidates them.
//! - `contract/managed/circle/keys/*.verifier` — gitignored compile output; the test SKIPS when absent.

use std::fs;
use std::path::PathBuf;

use midnight_base_crypto::signatures::Signature;
use midnight_coin_structure::contract::ContractAddress;
use midnight_ledger::structure::{ContractAction, ProofMarker, Transaction};
use midnight_onchain_runtime::state::ContractState;
use midnight_serialize::tagged_deserialize;
use midnight_storage::DefaultDB;
use midnight_transient_crypto::commitment::PedersenRandomness;

use midnight_native::deploy::{
    build_circle_deploy_tx, circle_contract_state, circle_deploy_address, circle_deploy_nonce,
    CIRCLE_ENTRY_POINTS,
};

type DB = DefaultDB;

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn inputs() -> ([u8; 32], bool, [u8; 32], [u8; 32], [u8; 32]) {
    let json =
        fs::read_to_string(repo_path("fixtures/circle_deploy.inputs.json")).expect("read inputs");
    let str_field = |key: &str| {
        let needle = format!("\"{key}\"");
        let start = json
            .find(&needle)
            .and_then(|i| json[i..].find(':').map(|j| i + j + 1))
            .expect("key");
        let rest = json[start..].trim_start();
        let quoted = rest.strip_prefix('"').expect("string value");
        quoted[..quoted.find('"').expect("closing quote")].to_string()
    };
    let bytes32 = |key: &str| -> [u8; 32] {
        hex::decode(str_field(key))
            .expect("hex")
            .try_into()
            .expect("32 bytes")
    };
    let is_open = json.contains("\"isOpen\": true");
    (
        bytes32("circleId"),
        is_open,
        bytes32("founderModerator"),
        bytes32("founderAuth"),
        bytes32("founderJoined"),
    )
}

fn verifier_keys(managed: &PathBuf) -> Vec<(&'static str, Vec<u8>)> {
    CIRCLE_ENTRY_POINTS
        .iter()
        .map(|name| {
            let path = managed.join(format!("keys/{name}.verifier"));
            (
                *name,
                fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display())),
            )
        })
        .collect()
}

/// The ledger state and the verifier-key map must equal what the SDK's deploy path produces, because
/// both feed the address.
///
/// The **maintenance authority deliberately does not**, and that is asserted separately below: the SDK
/// samples a signing key and installs a satisfiable one-key committee, where a circle is immutable by
/// decision. So this compares the two fields that must agree rather than the whole `ContractState`.
#[test]
fn deploy_state_matches_the_compiled_constructor() {
    let managed = repo_path("../../../contract/managed/circle");
    if !managed.exists() {
        eprintln!(
            "SKIP deploy_state_matches_the_compiled_constructor: {} missing",
            managed.display()
        );
        return;
    }
    let (circle_id, is_open, founder, founder_auth, founder_joined) = inputs();
    let raw =
        fs::read(repo_path("fixtures/circle_deploy.contract_state")).expect("read state fixture");
    let expected: ContractState<DB> =
        tagged_deserialize(&mut &raw[..]).expect("deserialize the SDK's deploy state");

    let actual = circle_contract_state(circle_id, is_open, founder, founder_auth, founder_joined, &verifier_keys(&managed))
        .expect("build state");

    assert!(
        actual.data.get_ref() == expected.data.get_ref(),
        "the Rust constructor built a different ledger state than the compiled one:\n  rust: {:?}\n  js:   {:?}",
        actual.data.get_ref(),
        expected.data.get_ref()
    );
    assert!(
        actual.operations == expected.operations,
        "the verifier-key map differs from the compiled contract's"
    );
    assert!(
        actual.balance == expected.balance,
        "a fresh contract holds nothing"
    );
}

/// Circles are immutable by decision, and the authority is part of the address — so this is a
/// property of every circle address we will ever issue, not an implementation detail.
///
/// `committee: []` with `threshold: 1` can never be satisfied: a maintenance update's every signature
/// index must resolve against the committee, and zero signatures miss the threshold. So no circle's
/// verifier keys can be swapped and no authority can be installed later.
///
/// It also must not be a *sampled* key, or the address would stop being derivable — which is exactly
/// what the SDK does, and why the fixture's authority differs from ours.
#[test]
fn circles_deploy_immutable() {
    let managed = repo_path("../../../contract/managed/circle");
    if !managed.exists() {
        eprintln!(
            "SKIP circles_deploy_immutable: {} missing",
            managed.display()
        );
        return;
    }
    let (circle_id, is_open, founder, founder_auth, founder_joined) = inputs();
    let state = circle_contract_state(circle_id, is_open, founder, founder_auth, founder_joined, &verifier_keys(&managed))
        .expect("build state");

    assert!(
        state.maintenance_authority.committee.is_empty(),
        "committee must be empty"
    );
    assert_eq!(
        state.maintenance_authority.threshold, 1,
        "threshold must be unreachable, not zero"
    );
    assert_eq!(state.maintenance_authority.counter, 0);

    let raw =
        fs::read(repo_path("fixtures/circle_deploy.contract_state")).expect("read state fixture");
    let sdk: ContractState<DB> = tagged_deserialize(&mut &raw[..]).expect("deserialize");
    assert!(
        sdk.maintenance_authority != state.maintenance_authority,
        "the SDK is expected to install a sampled, satisfiable authority — if this now matches ours, \
         re-check whether the SDK stopped sampling a signing key"
    );
}

/// The point of building the deploy natively: the address follows from the constructor's arguments,
/// so it can be derived and verified rather than taken on trust.
#[test]
fn the_address_is_reproducible_from_the_arguments() {
    let managed = repo_path("../../../contract/managed/circle");
    if !managed.exists() {
        eprintln!(
            "SKIP the_address_is_reproducible_from_the_arguments: {} missing",
            managed.display()
        );
        return;
    }
    let (circle_id, is_open, founder, founder_auth, founder_joined) = inputs();
    let keys = verifier_keys(&managed);

    let a = circle_deploy_address(circle_id, is_open, founder, founder_auth, founder_joined, &keys).expect("derive");
    let b = circle_deploy_address(circle_id, is_open, founder, founder_auth, founder_joined, &keys).expect("derive again");
    assert_eq!(a, b, "the same arguments must give the same address");

    // Each constructor argument is part of the address, so changing any one of them relocates the
    // circle. That is what stops a registry substituting a contract with its own founder.
    let mut other_id = circle_id;
    other_id[0] ^= 1;
    assert_ne!(
        a,
        circle_deploy_address(other_id, is_open, founder, founder_auth, founder_joined, &keys).expect("derive"),
        "circleId"
    );
    assert_ne!(
        a,
        circle_deploy_address(circle_id, !is_open, founder, founder_auth, founder_joined, &keys).expect("derive"),
        "isOpen"
    );
    let mut other_founder = founder;
    other_founder[0] ^= 1;
    assert_ne!(
        a,
        circle_deploy_address(circle_id, is_open, other_founder, founder_auth, founder_joined, &keys).expect("derive"),
        "founder"
    );
    // `founderAuth` is a constructor argument like the rest, so it relocates the circle too. Asserted
    // because it is the newest one and the easiest to drop from a caller without anything complaining.
    let mut other_auth = founder_auth;
    other_auth[0] ^= 1;
    assert_ne!(
        a,
        circle_deploy_address(circle_id, is_open, founder, other_auth, founder_joined, &keys).expect("derive"),
        "founderAuth"
    );
}

#[test]
fn the_nonce_is_domain_separated_per_circle() {
    let a = circle_deploy_nonce([1u8; 32]);
    let b = circle_deploy_nonce([2u8; 32]);
    assert_ne!(a.0, b.0);
}

/// The tx carries the deploy unchanged, and reports the address it will create — the sponsor balances
/// around it without being able to move it.
#[test]
fn the_deploy_tx_reports_the_address_it_creates() {
    let managed = repo_path("../../../contract/managed/circle");
    if !managed.exists() {
        eprintln!(
            "SKIP the_deploy_tx_reports_the_address_it_creates: {} missing",
            managed.display()
        );
        return;
    }
    let (circle_id, is_open, founder, founder_auth, founder_joined) = inputs();
    let keys = verifier_keys(&managed);
    let (bytes, address) =
        build_circle_deploy_tx(circle_id, is_open, founder, founder_auth, founder_joined, &keys, "", 4_102_444_800)
            .expect("build deploy tx");

    assert!(!bytes.is_empty(), "deploy tx must serialize");
    assert_eq!(
        address,
        circle_deploy_address(circle_id, is_open, founder, founder_auth, founder_joined, &keys).expect("derive"),
        "the tx must report the same address an offline derivation gives"
    );
}

/// The sponsor deserializes with `Transaction.deserialize('signature', 'proof', 'pre-binding', …)`
/// (`chain-client`'s `PROVEN_TX_MARKERS`), and that is a *tag*, checked before any content is read.
///
/// A deploy has no ZK proof, which made serializing the `ProofPreimageMarker` form look like the
/// honest thing to do — and it produced bytes the sponsor rejected with a header-tag mismatch, on a
/// path no Rust test exercised because every assertion stopped at "the bytes are non-empty". So this
/// asserts the *type* the bytes decode as, and that the address survives the round trip: proving a
/// deploy must not move the contract the caller was promised.
#[test]
fn the_deploy_tx_decodes_as_the_proven_form_the_sponsor_expects() {
    let managed = repo_path("../../../contract/managed/circle");
    if !managed.exists() {
        eprintln!(
            "SKIP the_deploy_tx_decodes_as_the_proven_form_the_sponsor_expects: {} missing",
            managed.display()
        );
        return;
    }
    let (circle_id, is_open, founder, founder_auth, founder_joined) = inputs();
    let keys = verifier_keys(&managed);
    let (bytes, address) =
        build_circle_deploy_tx(circle_id, is_open, founder, founder_auth, founder_joined, &keys, "", 4_102_444_800)
            .expect("build deploy tx");

    let tx: Transaction<Signature, ProofMarker, PedersenRandomness, DB> = tagged_deserialize(&mut &bytes[..])
        .expect("a deploy tx must decode as Transaction<signature, proof, pre-binding> — the sponsor's markers");

    let Transaction::Standard(standard) = tx else {
        panic!("a deploy must be a standard transaction, not a rewards claim");
    };
    let deployed: Vec<ContractAddress> = standard
        .actions()
        .filter_map(|(_, action)| match action {
            ContractAction::Deploy(deploy) => Some(deploy.address()),
            _ => None,
        })
        .collect();
    assert_eq!(
        deployed,
        vec![ContractAddress(midnight_base_crypto::hash::HashOutput(
            address
        ))]
    );
}
