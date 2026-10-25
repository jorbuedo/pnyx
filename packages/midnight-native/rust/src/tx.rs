//! Native assembly of a proven, unbound transaction — the last on-device step before the sponsor
//! balances the fee.
//!
//! Given a `ContractCallPrototype` (built + validated against the contract state by
//! [`crate::preimage`]), this wraps it in an `Intent`, wraps that in a `Transaction`, and proves
//! the whole transaction — reusing the exact per-circuit prove path [`crate::prove`] uses (same
//! `IrSource` / prover key / SRS, via `midnight_zkir::LocalProvingProvider`). The result is a
//! `Transaction<Signature, ProofMarker, PedersenRandomness>` — proven, signature-enabled, and
//! **pre-binding** (the fee is bound later by the sponsor's `balanceTx`). Its tagged serialization
//! is byte-identical to what `@midnight-ntwrk/ledger-v8`'s
//! `Transaction.deserialize('signature', 'proof', 'pre-binding', bytes)` reconstructs — i.e. exactly
//! what `chain-client`'s `submitProven` accepts.
//!
//! Why the whole tx and not the bare circuit proof: `Transaction::prove` overwrites each call's
//! `binding_input` with the intent's Pedersen `binding_commitment` (`ContractCall::prove` in
//! midnight-ledger), so a standalone circuit proof (bound to `binding_input = 0`, as
//! [`crate::prove::prove_circuit`] produces) cannot be transplanted into a transaction. Proving must
//! happen at the tx level — which is why this reuses the per-circuit keys but drives them through
//! `Transaction::prove`.

use std::io;

use futures::executor::block_on;
use midnight_base_crypto::signatures::Signature;
use midnight_base_crypto::time::Timestamp;
use midnight_ledger::construct::ContractCallPrototype;
use midnight_ledger::structure::{
    ContractDeploy, Intent, ProofMarker, ProofPreimageMarker, Transaction, UnshieldedOffer,
    UtxoOutput,
};
use midnight_onchain_runtime::cost_model::INITIAL_COST_MODEL;
use midnight_serialize::{tagged_deserialize, tagged_serialize, Serializable};
use midnight_storage::arena::Sp;
use midnight_storage::storage::Array as StorageArray;
use midnight_storage::storage::HashMap as StorageHashMap;
use midnight_storage::DefaultDB;
use midnight_transient_crypto::commitment::PedersenRandomness;
use midnight_transient_crypto::curve::Fr;
use midnight_transient_crypto::proofs::{
    KeyLocation, Proof, ProofPreimage, ProvingKeyMaterial, ProvingProvider, Resolver,
};
use midnight_zkir::LocalProvingProvider;
use rand::rngs::OsRng;

use crate::prove::FixedParams;

type DB = DefaultDB;
type UnprovenTx = Transaction<Signature, ProofPreimageMarker, PedersenRandomness, DB>;
type UnprovenIntent = Intent<Signature, ProofPreimageMarker, PedersenRandomness, DB>;

/// The intent segment id a single-party transaction uses (segment 0 is reserved / rejected).
///
/// ⚠️ **Two transactions at the same segment cannot be merged.** `Transaction::merge` is keyed by
/// segment id and refuses a collision with `key (segment_id) collision during intents merge: 1` —
/// measured against the pinned ledger, and pinned by
/// `packages/chain-client/src/ledger-merge.test.ts`. So every transaction this rail builds through the
/// default path lands here and no two of ours can be co-funded into one. The `_at_segment` variants
/// exist for that case; the ledger's own advice is a *random* segment
/// (`SegmentSpecifier { tag: 'random' }`, "ideal for merging with other intents").
///
/// ⚠️ The default is deliberately **not** randomized. Balancing is per segment — a deficit at segment
/// N is only cancellable by inputs in segment N's own intent — and the sponsor rail, the DUST fee
/// binding and every fixture built so far assume 1. Changing what one-party transactions use would
/// alter every path at once to buy nothing; a co-funding caller opts in instead.
pub const CALL_SEGMENT: u16 = 1;

/// A resolver over a single circuit's artifacts — a forum call tx has exactly one contract call, so
/// `LocalProvingProvider` only ever asks for this one circuit's keys (keyed by `KeyLocation`, which
/// the prototype set to the circuit name). Returns the same tagged bytes `prove_circuit` consumes.
struct SingleCircuitResolver {
    material: ProvingKeyMaterial,
}

impl Resolver for SingleCircuitResolver {
    async fn resolve_key(&self, _key: KeyLocation) -> io::Result<Option<ProvingKeyMaterial>> {
        Ok(Some(self.material.clone()))
    }
}

/// Assemble + prove a single-call transaction from a validated prototype, returning the tagged
/// `Transaction<Signature, ProofMarker, PedersenRandomness>` bytes.
///
/// `zkir`/`prover_key`/`verifier_key`/`params` are the same per-circuit artifacts
/// [`crate::prove::prove_circuit`] takes (the SRS for the circuit's K).
///
/// `network_id` binds the tx to a network and must be the chain's own id **string** — `"undeployed"`
/// for the local standalone stack, `"preprod"` for preprod. Not the empty string: the wallet refuses
/// the mismatch outright (`invalid network ID - expect '' found 'undeployed'`), which is a clear
/// message but only if you are reading it, and the app already passes the value `/auth/config`
/// reports.
///
/// `ttl_secs` is the intent's absolute expiry (unix seconds), derived by the caller from the current
/// time — and it has a **ceiling**: a far-future TTL is rejected at submission as
/// `1010: Invalid Transaction: Custom error: 182`, with nothing naming the TTL. An hour ahead is
/// what the app uses and is well inside it.
///
/// Proving is CPU-bound seconds and runs synchronously here (the bridge calls it off the JS thread).
#[allow(clippy::too_many_arguments)]
pub fn assemble_proven_tx(
    prototype: ContractCallPrototype<DB>,
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    assemble_proven_tx_with_mints(
        prototype,
        &[],
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
    )
}

/// The same, for a call that **mints an unshielded token to a user**.
///
/// ⚠️ **A mint is not complete without the output.** The transcript declares
/// `claimed_unshielded_spends[(type, User(recipient))] = amount`, and `Transaction::well_formed` checks
/// that every such claim is matched by a real output in the same intent and the same phase
/// (`verify.rs`'s `real_unshielded_spends.has_subset(&claimed_unshielded_spends)`). A call with no
/// offer is rejected by the node as `Custom error: 186 — Malformed::EffectsCheckFailure`, and neither a
/// circuit proof nor `QueryContext::query` can catch it: both see a transcript that is internally
/// consistent. This cost one on-chain submission to find.
///
/// The offer goes in the **fallible** slot to match the transcript's own phase — the check keys on
/// `(segment, logical_seg == 0)`, so a guaranteed output would not satisfy a fallible claim.
///
/// It carries **outputs and no inputs**, which is what a mint is: the contract creates the value, so
/// there is nothing to sign. `UnshieldedOffer::well_formed` requires one signature per *input*, and
/// there are none.
#[allow(clippy::too_many_arguments)]
pub fn assemble_proven_tx_with_mints(
    prototype: ContractCallPrototype<DB>,
    mints: &[UtxoOutput],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    assemble_proven_tx_with_mints_at_segment(
        prototype,
        mints,
        zkir,
        prover_key,
        verifier_key,
        params,
        network_id,
        ttl_secs,
        CALL_SEGMENT,
    )
}

/// As [`assemble_proven_tx_with_mints`], at a caller-chosen intent segment.
///
/// ⚠️ **Only a co-funding composer should pass anything but [`CALL_SEGMENT`].** The segment decides
/// which intent a deficit can be cancelled from, so a transaction whose funder contributes at a
/// different segment is *not* balanced by that contribution — see `crate::balance`. What it buys is
/// mergeability: two parties at distinct segments can be merged into one transaction, and two at the
/// same segment cannot.
#[allow(clippy::too_many_arguments)]
pub fn assemble_proven_tx_with_mints_at_segment(
    prototype: ContractCallPrototype<DB>,
    mints: &[UtxoOutput],
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    network_id: &str,
    ttl_secs: u64,
    segment: u16,
) -> Result<Vec<u8>, String> {
    let mut intent: UnprovenIntent =
        UnprovenIntent::empty(&mut OsRng, Timestamp::from_secs(ttl_secs))
            .add_call::<ProofPreimage>(prototype);
    if !mints.is_empty() {
        let mut outputs = StorageArray::<UtxoOutput, DB>::new();
        for output in mints {
            outputs = outputs.push(output.clone());
        }
        intent.fallible_unshielded_offer = Some(Sp::new(UnshieldedOffer {
            inputs: StorageArray::new(),
            outputs,
            signatures: StorageArray::new(),
        }));
    }
    let intents = StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(segment, intent);
    let tx = UnprovenTx::from_intents(network_id.to_string(), intents);

    let resolver = SingleCircuitResolver {
        material: ProvingKeyMaterial {
            prover_key: prover_key.to_vec(),
            verifier_key: verifier_key.to_vec(),
            ir_source: zkir.to_vec(),
        },
    };
    let fixed = FixedParams::read(params)?;
    let provider = LocalProvingProvider {
        rng: OsRng,
        resolver: &resolver,
        params: &fixed,
    };

    crate::diag::note(&format!(
        "tx prove: enter (segment {segment}, {} mints, zkir {} B, prover key {} B, srs {} B)",
        mints.len(),
        zkir.len(),
        prover_key.len(),
        params.len()
    ));
    let proven = block_on(tx.prove(provider, &INITIAL_COST_MODEL))
        .map_err(|e| format!("prove transaction: {e:?}"))?;
    crate::diag::note("tx prove: proved");

    let mut bytes = Vec::new();
    tagged_serialize(&proven, &mut bytes)
        .map_err(|e| format!("serialize proven transaction: {e}"))?;
    crate::diag::note(&format!("tx prove: serialized {} B", bytes.len()));
    Ok(bytes)
}

/// A proving provider for a transaction with nothing to prove.
///
/// `ContractAction::prove` clones a `Deploy` rather than proving it, and an unbalanced deploy tx has
/// no Zswap or Dust offers either — so no method here is ever reached. They fail loudly rather than
/// returning a placeholder: a call arriving on this path means a caller assembled the wrong tx shape,
/// and a stand-in proof would surface as a rejected transaction with no explanation.
struct NoCircuitProver;

impl ProvingProvider for NoCircuitProver {
    async fn check(&self, _preimage: &ProofPreimage) -> Result<Vec<Option<usize>>, anyhow::Error> {
        Err(
            io::Error::other("assemble_deploy_tx: this transaction has no circuits to prove")
                .into(),
        )
    }

    async fn prove(
        self,
        _preimage: &ProofPreimage,
        _overwrite_binding_input: Option<Fr>,
    ) -> Result<Proof, anyhow::Error> {
        Err(
            io::Error::other("assemble_deploy_tx: this transaction has no circuits to prove")
                .into(),
        )
    }

    fn split(&mut self) -> Self {
        NoCircuitProver
    }
}

/// Assemble a deploy transaction around a `ContractDeploy`, tagged-serialized for the sponsor to
/// balance and submit.
///
/// A constructor is not a circuit, so **no ZK proof is produced** — no prover key, no SRS, no
/// proving time. It still goes through `Transaction::prove`, because that is the only route to the
/// `Transaction<Signature, Proof, PreBinding>` tag that `chain-client`'s `submitProven` deserializes;
/// on a deploy that traversal is a clone. Serializing the `ProofPreimageMarker` form instead produces
/// bytes the sponsor rejects with a header-tag mismatch before it ever reaches the chain.
///
/// Nothing here touches the deploy itself, which is what keeps the address the caller derived intact
/// through balancing (see [`crate::deploy`]).
pub fn assemble_deploy_tx(
    deploy: ContractDeploy<DB>,
    network_id: &str,
    ttl_secs: u64,
) -> Result<Vec<u8>, String> {
    assemble_deploy_tx_at_segment(deploy, network_id, ttl_secs, CALL_SEGMENT)
}

/// As [`assemble_deploy_tx`], at a caller-chosen intent segment. Same warning as
/// [`assemble_proven_tx_with_mints_at_segment`]: this is for a co-funding composer, not for ordinary
/// deploys.
pub fn assemble_deploy_tx_at_segment(
    deploy: ContractDeploy<DB>,
    network_id: &str,
    ttl_secs: u64,
    segment: u16,
) -> Result<Vec<u8>, String> {
    let intent: UnprovenIntent =
        UnprovenIntent::empty(&mut OsRng, Timestamp::from_secs(ttl_secs)).add_deploy(deploy);
    let intents = StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(segment, intent);
    let tx = UnprovenTx::from_intents(network_id.to_string(), intents);

    let proven = block_on(tx.prove(NoCircuitProver, &INITIAL_COST_MODEL))
        .map_err(|e| format!("assemble deploy transaction: {e:?}"))?;

    let mut bytes = Vec::new();
    tagged_serialize(&proven, &mut bytes)
        .map_err(|e| format!("serialize deploy transaction: {e}"))?;
    Ok(bytes)
}

/// A proven, signature-enabled, pre-binding transaction — what this rail builds and what the sponsor
/// balances. Same marker triple as `chain-client`'s `PROVEN_TX_MARKERS`.
type ProvenTx = Transaction<Signature, ProofMarker, PedersenRandomness, DB>;

/// **The identifiers of a proven transaction, which are how a submission is tracked.**
///
/// Not the transaction hash. The ledger is explicit that `transaction_hash` must not be used to watch
/// for a specific transaction, because transactions can be *merged* — and the sponsor merges its
/// balancing into whatever it is handed, so the hash the device computes is not the hash that lands.
/// `identifiers` survives that: the ledger's own `has_identifier` is a containment test, not equality,
/// which is the shape a caller wants (is my identifier among the landed transaction's?).
///
/// **There is no hash to use instead.** The ledger refuses one outright for what this rail builds:
/// *"Transaction hash is available for proven, signed and bound transactions only."* Binding happens
/// at the sponsor, so the device cannot compute a hash for its own transfer at all — identifiers are
/// not the better handle here, they are the only one.
///
/// Hex-encoded with the identifier's plain `Serializable` encoding, **untagged**, which is the form the
/// indexer's `HexEncoded` identifier offset matches. Verified byte-for-byte against
/// `@midnight-ntwrk/ledger-v8`'s own `Transaction.identifiers()` for the same transaction: the encoding
/// is the whole correctness of this function, and a mismatch would silently return no rows rather than
/// fail. `dump_a_transfer_and_its_identifiers_for_the_ts_cross_check` reproduces the comparison.
pub fn proven_tx_identifiers(tx_bytes: &[u8]) -> Result<Vec<String>, String> {
    let tx: ProvenTx = tagged_deserialize(&mut &tx_bytes[..])
        .map_err(|e| format!("deserialize proven transaction: {e}"))?;
    let mut out = Vec::new();
    for ident in tx.identifiers() {
        let mut bytes = Vec::new();
        Serializable::serialize(&ident, &mut bytes)
            .map_err(|e| format!("serialize identifier: {e}"))?;
        out.push(bytes.iter().map(|b| format!("{b:02x}")).collect::<String>());
    }
    Ok(out)
}

#[cfg(test)]
mod segment_tests {
    use super::*;

    /// Build a bare transaction carrying one empty intent at `segment`.
    fn tx_at(segment: u16) -> UnprovenTx {
        let intent = UnprovenIntent::empty(&mut OsRng, Timestamp::from_secs(4_000_000_000));
        let intents = StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(segment, intent);
        UnprovenTx::from_intents("local-test".to_string(), intents)
    }

    /// ⚠️ **The reason `CALL_SEGMENT` is not the only option.** Two transactions this rail builds
    /// through the default path both land at segment 1, and the ledger refuses to merge them — which
    /// is what a Midnight co-funding flow runs into first.
    #[test]
    fn two_transactions_at_the_same_segment_cannot_merge() {
        let err = tx_at(CALL_SEGMENT)
            .merge(&tx_at(CALL_SEGMENT))
            .expect_err("two intents at one segment must not merge");
        // The typed variant, not a substring: the ledger names the colliding segment, and that is the
        // fact a co-funding composer has to act on.
        assert!(
            format!("{err:?}").contains("IntentSegmentIdCollision"),
            "expected a segment-id collision, got {err:?}"
        );
    }

    /// And the fix, proven rather than assumed: distinct segments merge, and the result carries both.
    #[test]
    fn two_transactions_at_distinct_segments_merge() {
        let merged = tx_at(1)
            .merge(&tx_at(2))
            .expect("distinct segments must merge");
        assert_eq!(
            merged.intents().count(),
            2,
            "the merged transaction should carry both intents"
        );
    }
}
