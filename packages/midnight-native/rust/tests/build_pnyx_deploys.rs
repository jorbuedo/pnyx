//! The deploy derivations for `identity.compact`, `handle.compact` and `payment.compact`.
//!
//! **A contract's address is a hash over its initial state**, so these tests exist to catch the one
//! failure that nothing else would report: a hand-built ledger state that differs from what the
//! compiled constructor produces. A single wrong cell makes every derived address wrong, every
//! lookup miss, and every name look free.
//!
//! ⚠️ Address derivation is why this lives in Rust at all. `ContractDeploy::new` samples its nonce
//! from `OsRng` and the wasm binding exposes no alternative, so an SDK-built deploy has a random
//! address — and a name with a random address is a name with no canonical contract.
//!
//! Fixtures come from the real compact runtime; regenerate with
//! `node --import tsx packages/midnight-native/scripts/dump-handle-fixtures.mts`.

use std::fs;
use std::path::PathBuf;

use midnight_native::deploy::{
    handle_contract_state_for_test, handle_deploy_address, handle_deploy_nonce,
    handle_moderate_domain, identity_contract_state_for_test, identity_deploy_address,
    identity_deploy_nonce, payment_contract_state_for_test, proposal_contract_state_for_test,
    proposal_deploy_address, proposal_deploy_nonce, proposal_vote_domain, read_verifier_keys,
    HANDLE_ENTRY_POINTS, IDENTITY_ENTRY_POINTS, PAYMENT_ENTRY_POINTS, PROPOSAL_ENTRY_POINTS,
};
use midnight_onchain_runtime::state::ContractState;
use midnight_serialize::tagged_deserialize;
use midnight_storage::DefaultDB;
use midnight_transient_crypto::curve::Fr;

type DB = DefaultDB;

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

fn managed(target: &str) -> Option<PathBuf> {
    let dir = repo_path(&format!("../../../contract/managed/{target}"));
    if dir.exists() {
        Some(dir)
    } else {
        eprintln!(
            "SKIP: {} is missing — run `bun run compile:contract`",
            dir.display()
        );
        None
    }
}

fn expected_state(fixture: &str) -> ContractState<DB> {
    let raw = fs::read(repo_path(&format!("fixtures/{fixture}"))).expect("read state fixture");
    tagged_deserialize(&mut &raw[..]).expect("deserialize the runtime's constructor state")
}

fn assert_same_state(actual: &ContractState<DB>, expected: &ContractState<DB>, what: &str) {
    assert!(
        actual.data.get_ref() == expected.data.get_ref(),
        "{what}: the Rust constructor built a different ledger state than the compiled one:\n  rust: {:?}\n  js:   {:?}",
        actual.data.get_ref(),
        expected.data.get_ref()
    );
    assert!(
        actual.operations == expected.operations,
        "{what}: the verifier-key map differs"
    );
    assert!(
        actual.balance == expected.balance,
        "{what}: a fresh contract holds nothing"
    );
}

#[test]
fn identity_state_matches_the_compiled_constructor() {
    let Some(managed) = managed("identity") else {
        return;
    };
    let json = inputs();
    let keys = read_verifier_keys(
        managed.join("keys").to_str().expect("path"),
        &IDENTITY_ENTRY_POINTS,
    )
    .expect("read verifier keys");
    let actual = identity_contract_state_for_test(bytes32(&json, "c"), &keys).expect("build state");
    assert_same_state(
        &actual,
        &expected_state("identity_fresh.contract_state"),
        "identity",
    );
}

#[test]
fn handle_state_matches_the_compiled_constructor() {
    let Some(managed) = managed("handle") else {
        return;
    };
    let json = inputs();
    let keys = read_verifier_keys(
        managed.join("keys").to_str().expect("path"),
        &HANDLE_ENTRY_POINTS,
    )
    .expect("read verifier keys");
    let actual =
        handle_contract_state_for_test(bytes32(&json, "name"), bytes32(&json, "payment"), &keys)
            .expect("build state");
    assert_same_state(
        &actual,
        &expected_state("handle_unbound.contract_state"),
        "handle",
    );
}

#[test]
fn payment_state_matches_the_compiled_constructor() {
    let Some(managed) = managed("payment") else {
        return;
    };
    let json = inputs();
    let keys = read_verifier_keys(
        managed.join("keys").to_str().expect("path"),
        &PAYMENT_ENTRY_POINTS,
    )
    .expect("read verifier keys");
    let actual = payment_contract_state_for_test(
        (false, [0u8; 32], bytes32(&json, "paymentTreasury")),
        (false, [0u8; 32], bytes32(&json, "paymentShieldedTreasury")),
        bytes32(&json, "adminAuth"),
        &keys,
    )
    .expect("build state");
    assert_same_state(
        &actual,
        &expected_state("payment_fresh.contract_state"),
        "payment",
    );
}

/// The property the whole bounded-state design rests on: one name, one address, derivable by anyone
/// holding the canonical spelling — so a second claim collides and the chain refuses it.
#[test]
fn a_handle_address_is_a_function_of_its_name() {
    let Some(managed) = managed("handle") else {
        return;
    };
    let json = inputs();
    let keys = read_verifier_keys(
        managed.join("keys").to_str().expect("path"),
        &HANDLE_ENTRY_POINTS,
    )
    .expect("read verifier keys");
    let payment = bytes32(&json, "payment");
    let name = bytes32(&json, "name");

    let once = handle_deploy_address(name, payment, &keys).expect("address");
    let again = handle_deploy_address(name, payment, &keys).expect("address");
    assert_eq!(
        once, again,
        "the same name must derive the same address every time"
    );

    let mut other = name;
    other[0] ^= 1;
    assert_ne!(
        once,
        handle_deploy_address(other, payment, &keys).expect("address")
    );

    // ⚠️ The payment address is sealed into the template, so it is part of the handle's address too.
    // That is what makes `PaymentContract` unreplaceable: a successor gives every name a new address.
    let mut other_payment = payment;
    other_payment[0] ^= 1;
    assert_ne!(
        once,
        handle_deploy_address(name, other_payment, &keys).expect("address")
    );
}

/// A handle carries no authority of its own: its `moderateDomain` is a pure function of the name, so
/// the colour `payment.grantModeratePermit` mints is the one that name's `moderate` will accept.
#[test]
fn a_moderation_domain_is_a_function_of_its_name() {
    // Pinned against the TypeScript `moderatePermitDomain` through the shared fixture, so all three
    // languages are asserted equal: Rust here, TS when the fixture was written, and the compiled
    // constructor via `handle_state_matches_the_compiled_constructor`.
    let json = inputs();
    assert_eq!(
        handle_moderate_domain(bytes32(&json, "name")),
        bytes32(&json, "moderateDomain"),
        "the Rust moderation domain must equal the one the client derives"
    );

    let name = [7u8; 32];
    let mut other = name;
    other[0] ^= 1;
    assert_eq!(handle_moderate_domain(name), handle_moderate_domain(name));
    assert_ne!(handle_moderate_domain(name), handle_moderate_domain(other));
    // Domain-separated from the other per-name colour, or a rebind permit would moderate.
    assert_ne!(handle_moderate_domain(name), handle_deploy_nonce(name).0);
}

#[test]
fn an_identity_address_is_a_function_of_c() {
    let Some(managed) = managed("identity") else {
        return;
    };
    let json = inputs();
    let keys = read_verifier_keys(
        managed.join("keys").to_str().expect("path"),
        &IDENTITY_ENTRY_POINTS,
    )
    .expect("read verifier keys");
    let c = bytes32(&json, "c");
    let once = identity_deploy_address(c, &keys).expect("address");
    assert_eq!(once, identity_deploy_address(c, &keys).expect("address"));
    let mut other = c;
    other[31] ^= 1;
    assert_ne!(
        once,
        identity_deploy_address(other, &keys).expect("address")
    );
}

/// The nonces are domain-separated, so the same 32 bytes read as a name and as a `C` cannot collide.
#[test]
fn the_nonces_are_domain_separated() {
    let x = [0x2au8; 32];
    assert_ne!(handle_deploy_nonce(x).0, identity_deploy_nonce(x).0);
}

/// The cross-language contract, pinned on both sides on purpose.
///
/// `derivations.test.ts` carries the same two vectors. Duplicating them is the point: changing one
/// language's nonce without the other fails a test on that side, where a shared helper would let both
/// drift together and every address move silently.
#[test]
fn the_nonces_match_the_typescript_vectors() {
    let json = inputs();
    assert_eq!(
        hex::encode(handle_deploy_nonce(bytes32(&json, "name")).0),
        "34dbb09a56da9f266af122e4c38889af8ff82cb48f03c67019988e3d3e3fef7b"
    );
    assert_eq!(
        hex::encode(identity_deploy_nonce(bytes32(&json, "c")).0),
        "ea92bfce3a30c3dfbb46d628b4a4612a4c4220633f08a616eda602e44da9b4dc"
    );
}

// ── proposal.compact ──
//
// A proposal is a **deploy**, so the same check applies: a single wrong cell makes every derived
// address wrong. Its fixture is `cast_vote.contract_state`, which is the constructor's own output
// (regenerate with `dump-vote-preimages.mts`).

fn members_root(json: &str, key: &str) -> Fr {
    let decimal = field(json, key);
    // The fixture records the root as a decimal string, which is how the JS ledger prints a Field.
    let mut acc = Fr::from(0u64);
    let ten = Fr::from(10u64);
    for ch in decimal.chars() {
        let digit = ch.to_digit(10).expect("membersRoot is decimal");
        acc = acc * ten + Fr::from(u64::from(digit));
    }
    acc
}

#[test]
fn proposal_state_matches_the_compiled_constructor() {
    let Some(managed) = managed("proposal") else {
        return;
    };
    let json = inputs();
    let keys = read_verifier_keys(
        managed.join("keys").to_str().expect("path"),
        &PROPOSAL_ENTRY_POINTS,
    )
    .expect("read verifier keys");
    let option_count: u8 = field(&json, "proposalOptionCount")
        .parse()
        .expect("optionCount is a number");
    let actual = proposal_contract_state_for_test(
        bytes32(&json, "proposalCircleId"),
        members_root(&json, "proposalMembersRoot"),
        bytes32(&json, "proposalContent"),
        bytes32(&json, "proposalAuthor"),
        option_count,
        &keys,
    )
    .expect("build state");
    assert_same_state(
        &actual,
        &expected_state("proposal_fresh.contract_state"),
        "proposal",
    );
}

/// The property that removes `createProposal` as a circuit: one (circle, content) pair, one address.
/// So two authors of different content never collide, and two authors of the *same* content do —
/// which the chain refuses as `ContractAlreadyDeployed` rather than storing two proposals.
#[test]
fn a_proposal_address_is_a_function_of_its_circle_and_content() {
    let Some(managed) = managed("proposal") else {
        return;
    };
    let json = inputs();
    let keys = read_verifier_keys(
        managed.join("keys").to_str().expect("path"),
        &PROPOSAL_ENTRY_POINTS,
    )
    .expect("read verifier keys");
    let option_count: u8 = field(&json, "proposalOptionCount")
        .parse()
        .expect("optionCount is a number");
    let circle = bytes32(&json, "proposalCircleId");
    let content = bytes32(&json, "proposalContent");
    let author = bytes32(&json, "proposalAuthor");
    let root = members_root(&json, "proposalMembersRoot");
    let at = |c: [u8; 32], b: [u8; 32]| {
        proposal_deploy_address(c, root, b, author, option_count, &keys).expect("address")
    };

    let once = at(circle, content);
    assert_eq!(
        once,
        at(circle, content),
        "the same proposal must derive the same address every time"
    );

    let mut other_content = content;
    other_content[0] ^= 1;
    assert_ne!(once, at(circle, other_content));

    let mut other_circle = circle;
    other_circle[0] ^= 1;
    assert_ne!(once, at(other_circle, content));

    // ⚠️ The electorate is sealed, so a proposal over the same content against a DIFFERENT root is a
    // different contract — which is what stops a stale snapshot being passed off as the current one.
    let different_root = proposal_deploy_address(
        circle,
        root + Fr::from(1u64),
        content,
        author,
        option_count,
        &keys,
    )
    .expect("address");
    assert_ne!(once, different_root);
}

/// The deploy nonce and the sealed vote domain are both `H(tag, circleId, content)` over identical
/// inputs, so only the tag separates them. A collision would make a proposal's address share a
/// preimage with its own vote nullifiers.
#[test]
fn the_proposal_nonce_and_vote_domain_are_domain_separated() {
    let circle = [0x01u8; 32];
    let content = [0x31u8; 32];
    assert_ne!(
        proposal_deploy_nonce(circle, content).0,
        proposal_vote_domain(circle, content)
    );
    // And each separates on both of its inputs.
    let mut other = content;
    other[0] ^= 1;
    assert_ne!(
        proposal_vote_domain(circle, content),
        proposal_vote_domain(circle, other)
    );
    assert_ne!(
        proposal_deploy_nonce(circle, content).0,
        proposal_deploy_nonce(circle, other).0
    );
}

/// The code digest is one construction with **three** implementations: this one, `sponsorship.ts` over
/// an on-chain `operations` map, and `artifacts.ts` over the compiled `keys/*.verifier` files. A drift
/// between them means a sponsor that stops recognising our own contracts and a Worker that stops
/// recognising an identity template — with the symptom arriving as an unexplained refusal.
///
/// So this compares the two *independent* paths rather than a recorded literal: the digest read out of a
/// deploy's `operations` (deserialized keys, re-serialized to hash) against the digest over the compiled
/// **files** on disk (raw bytes, the way the artifact service computes what it publishes). Equal means a
/// tagged round trip preserves the bytes, which is the actual risk here — and it is what makes the
/// manifest's value able to recognise a contract read off the chain.
#[test]
fn an_identity_deploy_hashes_the_way_the_artifact_service_does() {
    let Some(managed) = managed("identity") else {
        return;
    };
    let keys_dir = managed.join("keys");
    let keys = read_verifier_keys(keys_dir.to_str().expect("path"), &IDENTITY_ENTRY_POINTS)
        .expect("read verifier keys");
    let deploy = midnight_native::deploy::identity_deploy([0x2au8; 32], &keys).expect("deploy");
    let mut serialized = Vec::new();
    midnight_serialize::tagged_serialize(&deploy.initial_state, &mut serialized)
        .expect("serialize state");
    let from_state = midnight_native::identity::code_digest(&serialized).expect("digest");

    // `artifacts.ts`, in Rust: sha256 over `name | hex(sha256(file))` for every circuit, sorted by name.
    let mut names: Vec<&str> = IDENTITY_ENTRY_POINTS.to_vec();
    names.sort_unstable();
    let mut joined: Vec<u8> = Vec::new();
    for name in &names {
        let file = fs::read(keys_dir.join(format!("{name}.verifier"))).expect("read verifier file");
        joined.extend_from_slice(name.as_bytes());
        joined.extend_from_slice(
            hex::encode(midnight_base_crypto::hash::persistent_hash(&file).0).as_bytes(),
        );
    }
    let from_files = hex::encode(midnight_base_crypto::hash::persistent_hash(&joined).0);

    assert_eq!(
        from_state, from_files,
        "a tagged round trip changed the verifier key bytes"
    );
}
