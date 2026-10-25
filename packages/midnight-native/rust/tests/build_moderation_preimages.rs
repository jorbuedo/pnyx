//! Native preimage construction for `circle.compact`'s privileged circuits — `setInvite` (both arms),
//! `addModerator`, and the delegated invite authority's `issueInvite` (both arms) +
//! `setInviteAuthority`. Build each `ProofPreimage` in Rust, then prove + verify it host-side
//! against the compiled artifacts. **A verifying proof is the correctness oracle**: a transcript that
//! drifts by one op does not prove, and the node's own error would name neither op nor cause.
//!
//! ⚠️ **`setInvite`, `issueInvite` and `setInviteAuthority` are guaranteed; `addModerator` is
//! fallible.** Nothing reports which stage a transcript belongs in — a misplaced one fails at
//! submission with no mention of it — so every one was read off `dump-transcript.mts <circuit>`
//! rather than derived from the source.
//!
//! Both paths come out of the fixture state itself rather than being fixture *inputs*: a circle holds
//! its own trees, unlike a proposal, so `circle::member_path` and `circle::moderator_path` are the
//! same readers the app uses. That also means the paths cannot silently disagree with the state the
//! transcript is verified against.
//!
//! Artifacts:
//! - `fixtures/circle_populated.contract_state` — regenerate with
//!   `node --import tsx packages/midnight-native/scripts/dump-vote-preimages.mts`. Its founder is
//!   `personaCommitment(bytes32(11))` and that persona has joined, so it is both a moderator and a
//!   member, which is exactly what these circuits need between them. It also **delegates to
//!   `[0xa7; 32]`** and holds **one live invite (`[0x33; 32]`)** — the two pieces of state without
//!   which the authority gate and the revoke arms have nothing to run against.
//! - `contract/managed/circle/{zkir,keys}` — gitignored compile output; the test SKIPS loudly when
//!   absent, since a missing compile artifact is not a regression.
//! - KZG SRS — `$MIDNIGHT_PP` or `~/.cache/midnight/zk-params`.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use midnight_native::circle::{member_path, moderator_path};
use midnight_native::deploy::CIRCLE_ENTRY_POINTS;
use midnight_native::preimage::{
    build_add_moderator_preimage, build_issue_invite_preimage,
    build_set_invite_authority_preimage, build_set_invite_preimage, member_path_from_bytes,
    moderator_path_from_bytes,
};
use midnight_native::prove::{circuit_k, prove_circuit, verify_proof};

/// The fixture's founder persona — `personaCommitment(bytes32(11))`, computed the way the contract
/// does rather than pasted, so a derivation change fails here instead of drifting quietly.
fn founder_persona_sk() -> [u8; 32] {
    [11u8; 32]
}

const CONTRACT_ADDRESS: [u8; 32] = [0xba; 32];

/// The attestor secret `circle_populated.contract_state` delegates to — see `dump-vote-preimages.mts`.
const ATTESTOR_SK: [u8; 32] = [0xa7; 32];

/// The invite commitment the fixture already holds, so a revoke arm has something to remove.
const SEATED_INVITE: [u8; 32] = [0x33; 32];

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn srs_path(k: u8) -> Result<PathBuf, String> {
    let name = format!("bls_midnight_2p{k}");
    let dir = std::env::var("MIDNIGHT_PP")
        .map(PathBuf::from)
        .or_else(|_| {
            std::env::var("HOME")
                .map(|home| PathBuf::from(home).join(".cache/midnight/zk-params"))
                .map_err(|e| format!("$HOME not set: {e}"))
        })?;
    let path = dir.join(&name);
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("KZG params {name} not found in {}", dir.display()))
    }
}

struct Artifacts {
    zkir: Vec<u8>,
    prover: Vec<u8>,
    verifier: Vec<u8>,
    params: Vec<u8>,
    k: u8,
}

/// The compiled circuit's three files plus its SRS, or `None` when the contract has not been compiled.
fn artifacts(circuit: &str) -> Option<Artifacts> {
    let managed = repo_path("../../../contract/managed/circle");
    let zkir = fs::read(managed.join(format!("zkir/{circuit}.bzkir"))).ok()?;
    let prover = fs::read(managed.join(format!("keys/{circuit}.prover"))).ok()?;
    let verifier = fs::read(managed.join(format!("keys/{circuit}.verifier"))).ok()?;
    let k = circuit_k(&zkir).expect("read circuit k");
    let params = fs::read(srs_path(k).ok()?).ok()?;
    Some(Artifacts {
        zkir,
        prover,
        verifier,
        params,
        k,
    })
}

fn state() -> Vec<u8> {
    fs::read(repo_path("fixtures/circle_populated.contract_state"))
        .expect("read circle_populated.contract_state")
}

/// `persona_commitment(sk)` as the contract computes it — `persistentHash(["pnyx:pc", sk])`.
fn persona_commitment(sk: [u8; 32]) -> [u8; 32] {
    let mut tag = [0u8; 32];
    tag[.."pnyx:pc".len()].copy_from_slice(b"pnyx:pc");
    let mut input = Vec::with_capacity(64);
    input.extend_from_slice(&tag);
    input.extend_from_slice(&sk);
    midnight_base_crypto::hash::persistent_hash(&input).0
}

/// `inviteAuthorityCommitment(sk)` as the contract computes it — `persistentHash(["pnyx:ia", sk])`.
///
/// Recomputed here rather than imported, so the crate's own derivation is checked against a second
/// spelling of the same rule instead of against itself.
fn invite_authority_commitment(sk: [u8; 32]) -> [u8; 32] {
    let mut tag = [0u8; 32];
    tag[.."pnyx:ia".len()].copy_from_slice(b"pnyx:ia");
    let mut input = Vec::with_capacity(64);
    input.extend_from_slice(&tag);
    input.extend_from_slice(&sk);
    midnight_base_crypto::hash::persistent_hash(&input).0
}

fn prove_and_verify(circuit: &str, preimage: &[u8]) {
    let Some(a) = artifacts(circuit) else {
        eprintln!(
            "SKIP {circuit}: contract/managed/circle or the KZG params are absent — compile first"
        );
        return;
    };
    let started = Instant::now();
    let output = prove_circuit(&a.zkir, &a.prover, &a.verifier, &a.params, preimage).unwrap_or_else(|e| {
        panic!("{circuit}: the transcript did not prove — it has drifted from the compiled circuit: {e:?}")
    });
    let elapsed = started.elapsed();
    verify_proof(&a.verifier, &a.params, &output.proof, &output.public_inputs).unwrap_or_else(
        |e| panic!("{circuit}: the proof did not verify against its own verifier key: {e:?}"),
    );

    // ⚠️ Without this the verify above proves nothing: a check that accepts anything would still pass.
    let mut tampered = output.public_inputs.clone();
    tampered[0][0] ^= 1;
    assert!(
        verify_proof(&a.verifier, &a.params, &output.proof, &tampered).is_err(),
        "{circuit}: a tampered statement must not verify"
    );

    eprintln!(
        "{circuit}: K={} proved+verified in {} ms, proof {} bytes",
        a.k,
        elapsed.as_millis(),
        output.proof.len()
    );
}

#[test]
fn set_invite_issue_proves() {
    let state_bytes = state();
    let sk = founder_persona_sk();
    let path = moderator_path(&state_bytes, persona_commitment(sk))
        .expect("the founder moderates this circle");
    let entries = moderator_path_from_bytes(&path).expect("decode the moderator path");
    let preimage = build_set_invite_preimage(
        &state_bytes,
        CONTRACT_ADDRESS,
        sk,
        &entries,
        [0x33; 32],
        true,
    )
    .expect("build");
    prove_and_verify("setInvite", &preimage);
}

#[test]
fn add_moderator_proves() {
    let state_bytes = state();
    let sk = founder_persona_sk();
    let leaf = persona_commitment(sk);
    let mod_path = moderator_path(&state_bytes, leaf).expect("the founder moderates this circle");
    // The founder is also a member of this fixture, which is what makes them a legal promotion target.
    // `moderators.insert` has no uniqueness check, so promoting an existing moderator is mechanically
    // valid — and this test is about the transcript, not about who is worth promoting.
    let member = member_path(&state_bytes, leaf).expect("the founder is a member of this circle");
    let preimage = build_add_moderator_preimage(
        &state_bytes,
        CONTRACT_ADDRESS,
        sk,
        &moderator_path_from_bytes(&mod_path).expect("decode the moderator path"),
        leaf,
        &member_path_from_bytes(&member).expect("decode the member path"),
        [0x62; 32],
    )
    .expect("build");
    prove_and_verify("addModerator", &preimage);
}

/// The founder's moderator path out of the fixture — every moderator-gated test below starts here.
fn founder_moderator_path() -> Vec<(midnight_transient_crypto::curve::Fr, bool)> {
    let state_bytes = state();
    let path = moderator_path(&state_bytes, persona_commitment(founder_persona_sk()))
        .expect("the founder moderates this circle");
    moderator_path_from_bytes(&path).expect("decode the moderator path")
}

/// ⚠️ The arm that is a *different program*, not a different argument: revoking asserts the commitment
/// is present and removes it, where issuing only inserts. Proved separately because a prototype that
/// built the issue arm for both would still prove here if it were not.
#[test]
fn set_invite_revoke_proves() {
    let preimage = build_set_invite_preimage(
        &state(),
        CONTRACT_ADDRESS,
        founder_persona_sk(),
        &founder_moderator_path(),
        SEATED_INVITE,
        false,
    )
    .expect("build");
    prove_and_verify("setInvite", &preimage);
}

/// The refusal the revoke arm's `assert(on || invites.member(c))` exists to produce, reported by the
/// runtime before anything is proved rather than as a proof that does not verify.
#[test]
fn revoking_an_invite_that_was_never_issued_is_refused() {
    let refused = build_set_invite_preimage(
        &state(),
        CONTRACT_ADDRESS,
        founder_persona_sk(),
        &founder_moderator_path(),
        [0x77; 32],
        false,
    );
    assert!(
        refused.is_err(),
        "revoking an invite this circle never issued must refuse, not prove"
    );
}

/// `issueInvite` — the same body as `setInvite`, reached with **no moderator path at all**.
///
/// That absence is the property the whole design is for: the attestation service holds no persona and
/// moderates nothing, so a builder that needed a path could not run as it.
#[test]
fn issue_invite_proves() {
    let preimage = build_issue_invite_preimage(
        &state(),
        CONTRACT_ADDRESS,
        ATTESTOR_SK,
        [0x51; 32],
        true,
    )
    .expect("build");
    prove_and_verify("issueInvite", &preimage);
}

#[test]
fn issue_invite_revoke_proves() {
    let preimage = build_issue_invite_preimage(
        &state(),
        CONTRACT_ADDRESS,
        ATTESTOR_SK,
        SEATED_INVITE,
        false,
    )
    .expect("build");
    prove_and_verify("issueInvite", &preimage);
}

/// ⚠️ The refusal that makes the delegation a delegation. Reported by name from the builder, because
/// the transcript would otherwise run fine and fail *inside* the circuit — an unsatisfiable constraint
/// several layers from "you are not the authority".
#[test]
fn a_caller_who_is_not_the_authority_is_refused_by_name() {
    let refused = build_issue_invite_preimage(
        &state(),
        CONTRACT_ADDRESS,
        [0xbb; 32],
        [0x51; 32],
        true,
    );
    assert_eq!(
        refused.err().as_deref(),
        Some("not this circle's invite authority")
    );
}

/// `setInviteAuthority` — rotate the delegate. Moderator-gated, so this is the founder's call.
#[test]
fn set_invite_authority_proves() {
    let preimage = build_set_invite_authority_preimage(
        &state(),
        CONTRACT_ADDRESS,
        founder_persona_sk(),
        &founder_moderator_path(),
        invite_authority_commitment([0xc9; 32]),
    )
    .expect("build");
    prove_and_verify("setInviteAuthority", &preimage);
}

/// Withdrawal is a write of the zero value, and it is a **different encoding**: the runtime trims
/// trailing zeros, so an all-zero `Bytes<32>` is an empty atom rather than 32 bytes. A builder that
/// pushed the full width would prove nothing here.
#[test]
fn withdrawing_the_delegation_proves() {
    let preimage = build_set_invite_authority_preimage(
        &state(),
        CONTRACT_ADDRESS,
        founder_persona_sk(),
        &founder_moderator_path(),
        [0u8; 32],
    )
    .expect("build");
    prove_and_verify("setInviteAuthority", &preimage);
}

/// The fixture's own delegation, re-derived. Pins `dump-vote-preimages.mts`'s TypeScript
/// `inviteAuthorityCommitment` against this file's independent spelling of the same hash — a drifted
/// domain tag fails here rather than as an authority gate nobody can pass.
#[test]
fn the_fixture_delegates_to_the_attestor_secret() {
    let issued = build_issue_invite_preimage(
        &state(),
        CONTRACT_ADDRESS,
        ATTESTOR_SK,
        [0x51; 32],
        true,
    );
    assert!(
        issued.is_ok(),
        "the fixture's inviteAuthority is not invite_authority_commitment(ATTESTOR_SK): {:?}",
        issued.err()
    );
    assert_ne!(invite_authority_commitment(ATTESTOR_SK), [0u8; 32]);
}

/// The ledger slots `preimage.rs` hardcodes for `circle.compact`, pinned name-to-index against the
/// compiler's own metadata.
///
/// ⚠️ **This did not exist until `inviteAuthority` was ported**, which is why the slot constants had
/// only ever been checked by the proofs above — and a proof catches a *wrong* index but not an index
/// that is right today and moves tomorrow. `MODERATORS_IDX` already silently shifted 6 → 3 once when
/// `spentInvites` was deleted, and `identity.compact`'s equivalent move surfaced on a device as
/// "index out of bounds in idx", blaming the proof stage several layers from the cause.
///
/// The parse walks back from each `"index"` to its nearest preceding `"name":`, so it pins the pairing
/// rather than merely the order. Same reader as `handle_slots_match_the_compiled_contract`.
#[test]
fn circle_slots_match_the_compiled_contract() {
    let info = repo_path("../../../contract/managed/circle/compiler/contract-info.json");
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
    let mut slots: Vec<(String, usize)> = Vec::new();
    for (at, _) in ledger.match_indices("\"index\"") {
        let name_at = ledger[..at]
            .rfind("\"name\":")
            .expect("an index is preceded by a name");
        let name = ledger[name_at..]
            .split('"')
            .nth(3)
            .unwrap_or_default()
            .to_string();
        let index: usize = ledger[at..]
            .split(':')
            .nth(1)
            .and_then(|rest| rest.trim().split([',', '\n', '}']).next())
            .and_then(|n| n.trim().parse().ok())
            .expect("an index is a number");
        slots.push((name, index));
    }
    assert_eq!(
        slots,
        vec![
            ("circleId".to_string(), 0),
            ("isOpen".to_string(), 1),
            ("members".to_string(), 2),
            ("moderators".to_string(), 3),
            ("invites".to_string(), 4),
            ("joinedIdentities".to_string(), 5),
            ("moderatorAuth".to_string(), 6),
            ("inviteAuthority".to_string(), 7),
        ],
        "circle.compact's ledger layout moved — update the slot constants in preimage.rs and \
         LEDGER_FIELDS in deploy.rs"
    );
}

/// Every circuit the contract exports must be in `CIRCLE_ENTRY_POINTS`, and nothing else.
///
/// ⚠️ A deploy carries one verifier key per entry point and **all of it feeds the address**, so a
/// missing or extra name is a different contract at a different address — not a tolerable difference.
/// This is how the `issueInvite`/`setInviteAuthority` additions were caught as an address change
/// rather than as circles nobody could find.
#[test]
fn every_compiled_circuit_is_a_declared_entry_point() {
    let info = repo_path("../../../contract/managed/circle/compiler/contract-info.json");
    let Ok(json) = fs::read_to_string(&info) else {
        eprintln!(
            "SKIP entry-point check: {} is missing — run `bun run compile:contract`",
            info.display()
        );
        return;
    };
    let circuits = json
        .split("\"circuits\"")
        .nth(1)
        .and_then(|rest| rest.split("\"witnesses\"").next())
        .expect("contract-info.json has a circuits section");
    let mut compiled: Vec<String> = Vec::new();
    for (at, _) in circuits.match_indices("\"name\":") {
        compiled.push(
            circuits[at..]
                .split('"')
                .nth(3)
                .unwrap_or_default()
                .to_string(),
        );
    }
    let mut compiled_sorted = compiled.clone();
    compiled_sorted.sort();
    let mut declared: Vec<String> = CIRCLE_ENTRY_POINTS.iter().map(|s| s.to_string()).collect();
    declared.sort();
    assert_eq!(
        compiled_sorted, declared,
        "circle.compact's entry points moved — update CIRCLE_ENTRY_POINTS in deploy.rs"
    );
}
