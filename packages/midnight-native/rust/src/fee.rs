//! Paying a transaction's DUST fee from a wallet that did not build it.
//!
//! The sponsor's job, done locally. A caller hands over any proven, signature-enabled, **pre-binding**
//! transaction — composed by a dApp over the connector, by an agent over MCP, by this app for a
//! different wallet, or by a wholly different seed phrase — and this attaches a DUST spend of *this*
//! wallet's, proves it, merges, and seals. Nothing about the transaction's author is assumed or
//! required: the fee payer and the transaction's signer are independent by construction.
//!
//! ## Why the fee can ride in an intent of our own
//!
//! [`crate::balance`] explains why the caller's *own* intent cannot be extended: `Intent::sign` covers
//! the proof- and signature-erased intent, so adding an unshielded input voids signatures belonging to
//! keys we do not hold. A DUST fee is not added that way, and does not have to be.
//!
//! The ledger accounts DUST **transaction-wide at segment 0**, whichever intent carries the spend
//! (`verify.rs`: every `intent.dust_actions.spends` adds `v_fee` to `(TokenType::Dust, 0)`, and the fee
//! subtracts from that same entry, `FEE_TOKEN == TokenType::Dust`). And the spend's proof binds to its
//! **own** intent — `DustActions::prove` is handed `self.binding_commitment`, and `well_formed` checks
//! it against `parent.binding_commitment`, `parent` being the intent the spend sits in.
//!
//! So a spend in a fresh intent at a free segment pays for the whole transaction while touching
//! nothing of the caller's. That is precisely what the sponsor does server-side
//! (`packages/chain-client/src/foreign-balancing.ts`: the fee rides in a separate *balancing
//! transaction* that is merged in, leaving the base byte-identical), and the reason that file exists
//! is that the SDK's default path appended a signature to the caller's own offer and got
//! `1010: Custom error: 192` (`InputsSignaturesLengthMismatch`) on preprod.
//!
//! ## Why merging is safe here
//!
//! `Transaction::merge` chains intents by segment id and refuses a collision; per-intent
//! `binding_commitment`s pass through untouched, so a proof bound to one stays valid. Only the
//! transaction-level `binding_randomness` is summed, which is what `seal` then consumes. Both halves
//! must therefore be **pre-binding** when they meet — merging after sealing is not a thing.
//!
//! ## Ordering
//!
//! Price, spend, prove, merge, seal — in that order, and the order is forced. The spend's proof
//! commits to the fee value and to the intent's binding commitment, so the fee has to be known before
//! proving; sealing rewrites every binding commitment, so it has to come after.

use midnight_base_crypto::signatures::Signature;
use midnight_base_crypto::time::Timestamp;
use midnight_coin_structure::coin::TokenType;
use midnight_ledger::dust::{DustActions, DustLocalState};
use midnight_ledger::structure::{
    Intent, ProofMarker, ProofPreimageMarker, Transaction, INITIAL_PARAMETERS,
};
use midnight_onchain_runtime::cost_model::INITIAL_COST_MODEL;
use midnight_serialize::{tagged_deserialize, tagged_serialize, Serializable};
use midnight_storage::storage::HashMap as StorageHashMap;
use midnight_transient_crypto::commitment::PedersenRandomness;
use midnight_zkir::LocalProvingProvider;
use rand::rngs::OsRng;

use futures::executor::block_on;

use crate::state_read::DB;

/// The marker triple a transaction must arrive in: proven, signature-enabled, not yet bound. Same
/// shape [`crate::balance`] funds and the sponsor balances.
type UnboundTx = Transaction<Signature, ProofMarker, PedersenRandomness, DB>;
type UnprovenIntent = Intent<Signature, ProofPreimageMarker, PedersenRandomness, DB>;
type UnprovenTx = Transaction<Signature, ProofPreimageMarker, PedersenRandomness, DB>;

/// How many times the fee is re-priced before giving up. Each round adds at most the bytes a larger
/// SCALE-compact `u128` takes, so a fee that has not settled by the third round is not converging.
const PRICING_ROUNDS: usize = 6;

/// Everything the fee payer contributes. The transaction itself says nothing about who pays it.
pub struct DustFeeRequest<'a> {
    /// Proven, signature-enabled, pre-binding bytes — whoever built them.
    pub transaction: &'a [u8],
    /// A **synced** `DustLocalState`. A fast-synced state cannot prove a spend: the spend's circuit
    /// checks membership against the chain's own commitment and generation roots, which are only
    /// correct once the wallet has replayed the events that built them.
    pub dust_state: &'a [u8],
    pub dust_role_key: &'a [u8; 32],
    /// The instant the DUST is valued at, in Unix seconds. The node rejects a `ctime` in the future or
    /// older than `dust_grace_period` (`OutOfDustValidityWindow`), so this must be close to now.
    pub ctime_secs: u64,
    /// TTL of the fee intent, in Unix seconds.
    pub ttl_secs: u64,
    /// Holds `spend.{bzkir,prover,verifier}` for `midnight/dust/spend`.
    pub artifact_dir: &'a str,
    /// Holds `bls_midnight_2p13`.
    pub params_dir: &'a str,
    /// Exponent for `fees_with_margin`, absorbing the dust price moving between building and
    /// inclusion. The fee intent's own size is measured rather than estimated, so this covers price
    /// drift alone.
    pub fee_margin: usize,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn deserialize_unbound(tx_bytes: &[u8]) -> Result<UnboundTx, String> {
    tagged_deserialize(&mut &tx_bytes[..]).map_err(|e| {
        format!("not a proven, signature-enabled, pre-binding transaction (Transaction<SignatureEnabled, Proof, PreBinding>): {e}")
    })
}

/// The lowest segment ≥ 1 the transaction does not already carry an intent at.
///
/// Segment 0 is excluded by the ledger itself (`IntentAtGuaranteedSegmentId`), and a collision is
/// `IntentSegmentIdCollision` at merge — so this is the one degree of freedom the fee intent has.
fn free_segment(tx: &UnboundTx) -> Result<u16, String> {
    let used: Vec<u16> = match tx {
        Transaction::Standard(stx) => stx.intents().map(|(segment, _)| segment).collect(),
        Transaction::ClaimRewards(_) => Vec::new(),
    };
    (1..=u16::MAX)
        .find(|segment| !used.contains(segment))
        .ok_or_else(|| {
            "this transaction occupies every intent segment; there is nowhere to put a fee"
                .to_string()
        })
}

/// What the transaction still owes in DUST once `fee` is charged against whatever it already carries.
///
/// Reading the ledger's own balance map rather than assuming the fee is the whole bill: a transaction
/// may already carry dust spends or a registration's `allow_fee_payment` — a partly-funded
/// multi-party transaction does — and paying the full fee on top would burn the difference.
fn dust_owed(tx: &UnboundTx, fee: u128) -> Result<u128, String> {
    let balance = tx
        .balance(Some(fee))
        .map_err(|e| format!("the ledger could not balance this transaction: {e:?}"))?;
    let delta = balance.get(&(TokenType::Dust, 0)).copied().unwrap_or(0);
    Ok(if delta < 0 { delta.unsigned_abs() } else { 0 })
}

/// An intent whose only content is a DUST spend: no offers, no contract actions, nothing to sign.
///
/// `Intent::sign` walks the unshielded offers and the dust *registrations* only, so an intent carrying
/// a bare spend needs no signature from anybody — which is what lets a fee payer stay anonymous to the
/// transaction it is paying for.
fn fee_intent(
    spend: midnight_ledger::dust::DustSpend<ProofPreimageMarker, DB>,
    ctime: Timestamp,
    ttl: Timestamp,
) -> UnprovenIntent {
    UnprovenIntent::new(
        &mut OsRng,
        None,
        None,
        vec![],
        vec![],
        vec![],
        Some(DustActions::<Signature, ProofPreimageMarker, DB> {
            spends: vec![spend].into(),
            registrations: vec![].into(),
            ctime,
        }),
        ttl,
    )
}

fn fee_tx(intent: UnprovenIntent, segment: u16, network_id: &str) -> UnprovenTx {
    UnprovenTx::from_intents(
        network_id.to_string(),
        StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(segment, intent),
    )
}

fn network_id_of(tx: &UnboundTx) -> Result<String, String> {
    match tx {
        Transaction::Standard(stx) => Ok(stx.network_id.clone()),
        Transaction::ClaimRewards(claim) => Ok(claim.network_id.clone()),
    }
}

/// Pay `transaction`'s DUST fee from this wallet, and return it sealed and submittable.
///
/// Returns JSON `{"tx","state","fee","paid","segment","identifiers"}`:
/// - `tx` — sealed bytes, submittable as-is. Nobody else has to bind them.
/// - `state` — the DUST state with the spent output pending. ⚠️ **Persist this one.** Keeping the
///   state that went in would let the next fee pick the same output, and the ledger rejects the pair.
/// - `fee` — what the transaction costs, in SPECK, as a decimal string.
/// - `paid` — what *this wallet* contributed. Less than `fee` when the transaction already carried
///   DUST of its own, which a partly-funded multi-party transaction does; equal to it otherwise. The
///   two are separate because reporting the bill as the payment would misstate both.
/// - `segment` — where the fee intent landed.
/// - `identifiers` — read **before** the seal, because they cannot be recovered afterwards: a proven
///   transaction's header is `embedded-fr` and a sealed one is `pedersen-schnorr`. This is the same
///   trap that made every self-funded send untrackable ([`crate::unshielded`]).
///
/// ⚠️ **A zero fee is a real answer.** The dust price decays on an idle chain, and a transaction that
/// prices to nothing gets no dust action at all — the node rejects an *empty* `DustActions` as
/// `NotNormalized` (`1010: Custom error: 117`). The result then carries `"paid":"0"` and the DUST state
/// unchanged, and `tx` is the caller's own transaction, sealed. The same result stands when the
/// transaction already carries all the DUST it needs.
pub fn pay_fee_from_dust_json(request: DustFeeRequest<'_>) -> Result<String, String> {
    let base = deserialize_unbound(request.transaction)?;
    let network_id = network_id_of(&base)?;
    let segment = free_segment(&base)?;
    let ctime = Timestamp::from_secs(request.ctime_secs);
    let ttl = Timestamp::from_secs(request.ttl_secs);

    let dust_state: DustLocalState<DB> = tagged_deserialize(&mut &request.dust_state[..])
        .map_err(|e| format!("deserialize dust state: {e}"))?;
    let dust_sk = crate::dust::secret_key(request.dust_role_key);

    // Pass one prices the transaction *without* our intent, which is the lower bound and the only
    // figure available before a spend exists to size.
    let base_fee = base
        .fees_with_margin(&INITIAL_PARAMETERS, request.fee_margin)
        .map_err(|e| format!("price the transaction: {e:?}"))?;
    let owed_before = dust_owed(&base, base_fee)?;
    if owed_before == 0 {
        // Nothing to pay — either the chain is idle enough to be free, or the transaction already
        // carries the DUST it needs. Sealing is still ours to do: the caller handed over pre-binding
        // bytes, and unbound bytes are not submittable.
        let sealed = base.seal(OsRng);
        let mut tx_bytes = Vec::new();
        tagged_serialize(&sealed, &mut tx_bytes)
            .map_err(|e| format!("serialize the sealed transaction: {e}"))?;
        let identifiers = identifiers_of(&base)?;
        return Ok(format!(
            "{{\"tx\":\"{}\",\"state\":\"{}\",\"fee\":\"{base_fee}\",\"paid\":\"0\",\"segment\":{segment},\"identifiers\":[{}]}}",
            hex(&tx_bytes),
            hex(request.dust_state),
            identifiers.join(","),
        ));
    }

    // ⚠️ Pricing iterates because the fee's own magnitude changes the transaction's size: `u128`
    // serializes through `ScaleBigInt`, SCALE *compact*, one to seventeen bytes by magnitude. So this
    // climbs until the spend covers the transaction that spend produces — a surplus is a legal
    // positive balance, a speck short is refused.
    let (owed, priced) = {
        let mut owed = owed_before;
        let mut settled: Option<(u128, u128)> = None;
        for _ in 0..PRICING_ROUNDS {
            let (_, trial) = crate::unshielded::spend_for_fee(&dust_state, &dust_sk, owed, ctime)?;
            let merged = base
                .erase_proofs()
                .merge(&fee_tx(fee_intent(trial, ctime, ttl), segment, &network_id).erase_proofs())
                .map_err(|e| format!("size the fee intent against the transaction: {e:?}"))?;
            let priced = merged
                .fees_with_margin(&INITIAL_PARAMETERS, request.fee_margin)
                .map_err(|e| format!("price the transaction with its fee intent: {e:?}"))?;
            let need = dust_owed(&base, priced)?;
            if need <= owed {
                settled = Some((owed, priced));
                break;
            }
            owed = need;
        }
        settled.ok_or_else(|| {
            format!("the fee did not settle in {PRICING_ROUNDS} rounds, last asking {owed}; the price is moving faster than the transaction is growing")
        })?
    };

    let (next_dust_state, spend) =
        crate::unshielded::spend_for_fee(&dust_state, &dust_sk, owed, ctime)?;
    let unproven = fee_tx(fee_intent(spend, ctime, ttl), segment, &network_id);

    // The K=13 `midnight/dust/spend` circuit, served from the artifacts the host cached. This is the
    // only proving here: the caller's half arrived proven, and merging proves nothing.
    let resolver = crate::wallet::DirResolver {
        dir: std::path::PathBuf::from(request.artifact_dir),
    };
    let params = crate::wallet::DirParams {
        dir: std::path::PathBuf::from(request.params_dir),
    };
    let provider = LocalProvingProvider {
        rng: OsRng,
        params: &params,
        resolver: &resolver,
    };
    let proven_fee = block_on(unproven.prove(provider, &INITIAL_COST_MODEL))
        .map_err(|e| format!("prove the dust spend: {e:?}"))?;

    let merged = base
        .merge(&proven_fee)
        .map_err(|e| format!("merge the fee intent into the transaction: {e:?}"))?;

    // The node applies `fees(params, true)` — the time-to-dismiss bound — where our own pricing used
    // `false`. Checking here turns a submission that would be refused on chain into an error naming
    // the transaction that caused it.
    merged.fees(&INITIAL_PARAMETERS, true).map_err(|e| {
        format!("the funded transaction is outside the time-to-dismiss bound: {e:?}")
    })?;

    let identifiers = identifiers_of(&merged)?;
    let sealed = merged.seal(OsRng);

    let mut tx_bytes = Vec::new();
    tagged_serialize(&sealed, &mut tx_bytes)
        .map_err(|e| format!("serialize the sealed transaction: {e}"))?;
    let mut state_bytes = Vec::new();
    tagged_serialize(&next_dust_state, &mut state_bytes)
        .map_err(|e| format!("serialize the dust state: {e}"))?;

    Ok(format!(
        "{{\"tx\":\"{}\",\"state\":\"{}\",\"fee\":\"{priced}\",\"paid\":\"{owed}\",\"segment\":{segment},\"identifiers\":[{}]}}",
        hex(&tx_bytes),
        hex(&state_bytes),
        identifiers.join(","),
    ))
}

fn identifiers_of(tx: &UnboundTx) -> Result<Vec<String>, String> {
    let mut identifiers = Vec::new();
    for ident in tx.identifiers() {
        let mut bytes = Vec::new();
        Serializable::serialize(&ident, &mut bytes)
            .map_err(|e| format!("serialize identifier: {e}"))?;
        identifiers.push(format!("\"{}\"", hex(&bytes)));
    }
    Ok(identifiers)
}

/// [`pay_fee_from_dust_json`] for the bridges: fixed-width in, JSON out.
#[allow(clippy::too_many_arguments)]
pub fn pay_fee_from_dust_hex(
    transaction: &[u8],
    dust_state: &[u8],
    dust_role_key: &[u8; 32],
    ctime_secs: u64,
    ttl_secs: u64,
    artifact_dir: &str,
    params_dir: &str,
    fee_margin: usize,
) -> Result<String, String> {
    pay_fee_from_dust_json(DustFeeRequest {
        transaction,
        dust_state,
        dust_role_key,
        ctime_secs,
        ttl_secs,
        artifact_dir,
        params_dir,
        fee_margin,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::unshielded::{
        build_unshielded_transfer_tx, UnshieldedInput, UnshieldedTransferRequest,
    };
    use midnight_base_crypto::hash::HashOutput;
    use midnight_ledger::dust::{
        dust_nonce, DustGenerationInfo, DustPublicKey, InitialNonce, QualifiedDustOutput,
    };

    const NIGHT: [u8; 32] = [0u8; 32];
    const CREATED: u64 = 1_700_000_000;
    /// A year after the NIGHT was received, so the generation has run well up towards its cap.
    const NOW: u64 = CREATED + 365 * 24 * 3600;

    /// A real proven, unbound transaction — authored by a key that has nothing to do with the wallet
    /// that will pay for it. An unshielded transfer needs no circuit, so this costs no artifacts.
    fn a_transfer_by_someone_else() -> UnboundTx {
        let bytes = build_unshielded_transfer_tx(UnshieldedTransferRequest {
            night_role_key: &[7u8; 32],
            inputs: &[UnshieldedInput {
                value: 2_000_000,
                token_type: NIGHT,
                intent_hash: [1u8; 32],
                output_no: 0,
            }],
            recipient_address: [9u8; 32],
            token_type: NIGHT,
            value: 1_000_000,
            network_id: "undeployed",
            ttl_secs: 1_800_000_000,
            change_chunks: 1,
        })
        .expect("build a transfer");
        deserialize_unbound(&bytes).expect("a proven, unbound transfer")
    }

    /// A DUST state holding one generating entry and the output it backs — enough to pay a fee from.
    fn funded_dust_state(dust_role_key: &[u8; 32], night_value: u128) -> DustLocalState<DB> {
        let sk = crate::dust::secret_key(dust_role_key);
        let owner = DustPublicKey::from(sk.clone());
        let backing = InitialNonce(HashOutput([7u8; 32]));
        let state = DustLocalState::<DB>::new(INITIAL_PARAMETERS.dust)
            .insert_generation_info(
                0,
                DustGenerationInfo {
                    value: night_value,
                    owner,
                    nonce: backing,
                    dtime: Timestamp::MAX,
                },
                Some(backing),
            )
            .expect("insert generation info");
        let utxo = QualifiedDustOutput {
            initial_value: 0,
            owner,
            nonce: dust_nonce(&backing, 0, &sk),
            seq: 0,
            ctime: Timestamp::from_secs(CREATED),
            backing_night: backing,
            mt_index: 0,
        };
        state
            .insert_commitment(0, utxo, true)
            .expect("insert commitment")
            .add_utxo(&utxo.nullifier(&sk), &utxo, None)
            .expect("add utxo")
    }

    #[test]
    fn the_fee_intent_goes_beside_the_transaction_not_into_it() {
        let tx = a_transfer_by_someone_else();
        // Every builder in this crate places its intent at segment 1, so 2 is the first one free.
        // Segment 0 is not a candidate at all: the ledger rejects an intent there outright.
        assert_eq!(free_segment(&tx).expect("a free segment"), 2);
    }

    #[test]
    fn a_transaction_carrying_no_dust_owes_the_whole_fee() {
        let tx = a_transfer_by_someone_else();
        assert_eq!(dust_owed(&tx, 1_234).expect("balance"), 1_234);
    }

    /// A surplus is not a debt. `balance` keeps the ledger's sign and a positive entry is legal, so a
    /// transaction that already carries more DUST than it needs must read as owing nothing rather than
    /// as owing the absolute difference.
    #[test]
    fn a_transaction_that_owes_nothing_reads_as_zero() {
        let tx = a_transfer_by_someone_else();
        assert_eq!(dust_owed(&tx, 0).expect("balance"), 0);
    }

    /// The fee intent is signature-free by construction: `Intent::sign` touches unshielded offers and
    /// dust *registrations*, and this carries neither. That is what lets a wallet pay for a
    /// transaction whose keys it does not hold.
    #[test]
    fn the_fee_intent_carries_nothing_that_needs_signing() {
        let state = funded_dust_state(&[5u8; 32], 5_000_000_000_000);
        let sk = crate::dust::secret_key(&[5u8; 32]);
        let (_, spend) =
            crate::unshielded::spend_for_fee(&state, &sk, 1_000, Timestamp::from_secs(NOW))
                .expect("a funded state can pay a fee");
        let intent = fee_intent(
            spend,
            Timestamp::from_secs(NOW),
            Timestamp::from_secs(NOW + 3600),
        );
        assert!(intent.guaranteed_unshielded_offer.is_none());
        assert!(intent.fallible_unshielded_offer.is_none());
        assert_eq!(intent.actions.len(), 0);
        let dust = intent.dust_actions.as_ref().expect("a dust action");
        assert_eq!(
            dust.spends.len(),
            1,
            "one output pays a fee; a fee needing two is reported, not split"
        );
        assert!(
            dust.registrations.is_empty(),
            "a fee payer registers nothing"
        );
    }

    /// The whole point of the module, minus the proof: a fee intent built for someone else's
    /// transaction merges with it, lands beside it, and leaves the original intent untouched.
    ///
    /// Merging *erased* halves is what the pricing pass does, and it exercises the same collision rule
    /// as the real merge — the proven merge differs only in that its DustSpend carries a proof.
    #[test]
    fn the_merged_transaction_carries_both_intents_and_changes_neither() {
        let base = a_transfer_by_someone_else();
        let state = funded_dust_state(&[5u8; 32], 5_000_000_000_000);
        let sk = crate::dust::secret_key(&[5u8; 32]);
        let segment = free_segment(&base).expect("a free segment");
        let (_, spend) =
            crate::unshielded::spend_for_fee(&state, &sk, 1_000, Timestamp::from_secs(NOW))
                .expect("a funded state can pay a fee");
        let ours = fee_tx(
            fee_intent(
                spend,
                Timestamp::from_secs(NOW),
                Timestamp::from_secs(NOW + 3600),
            ),
            segment,
            "undeployed",
        );

        let base_erased = base.erase_proofs();
        let merged = base_erased.merge(&ours.erase_proofs()).expect("merge");
        let Transaction::Standard(stx) = &merged else {
            panic!("a standard transaction")
        };
        assert_eq!(
            stx.intents().count(),
            2,
            "the caller's intent and ours, side by side"
        );

        let Transaction::Standard(before) = &base_erased else {
            panic!("a standard transaction")
        };
        let theirs_before = before.intents.get(&1).expect("the transfer's intent");
        let theirs_after = stx
            .intents
            .get(&1)
            .expect("the transfer's intent, after merging");
        assert_eq!(
            *theirs_before, *theirs_after,
            "merging must leave the caller's intent byte-identical — signatures over it stay valid only if it does"
        );
        assert!(
            stx.intents.get(&segment).is_some(),
            "our fee intent landed at the free segment"
        );
    }

    /// A fee cannot be put where an intent already is: `Transaction::merge` refuses the collision, and
    /// this is the rule `free_segment` exists to respect.
    #[test]
    fn two_intents_at_one_segment_refuse_to_merge() {
        let base = a_transfer_by_someone_else();
        let state = funded_dust_state(&[5u8; 32], 5_000_000_000_000);
        let sk = crate::dust::secret_key(&[5u8; 32]);
        let (_, spend) =
            crate::unshielded::spend_for_fee(&state, &sk, 1_000, Timestamp::from_secs(NOW))
                .expect("a funded state can pay a fee");
        let colliding = fee_tx(
            fee_intent(
                spend,
                Timestamp::from_secs(NOW),
                Timestamp::from_secs(NOW + 3600),
            ),
            1,
            "undeployed",
        );
        base.erase_proofs()
            .merge(&colliding.erase_proofs())
            .expect_err("a fee intent at the transfer's own segment must not merge");
    }

    /// Pricing is a two-pass affair, and the second pass has to be bigger: the fee intent adds a dust
    /// spend's proof and its own intent overhead to the transaction being priced.
    #[test]
    fn adding_the_fee_intent_raises_the_price() {
        let base = a_transfer_by_someone_else();
        let state = funded_dust_state(&[5u8; 32], 5_000_000_000_000);
        let sk = crate::dust::secret_key(&[5u8; 32]);
        let segment = free_segment(&base).expect("a free segment");
        let base_fee = base
            .fees_with_margin(&INITIAL_PARAMETERS, 2)
            .expect("price the base");
        let (_, spend) = crate::unshielded::spend_for_fee(
            &state,
            &sk,
            base_fee.max(1),
            Timestamp::from_secs(NOW),
        )
        .expect("a funded state can pay a fee");
        let merged = base
            .erase_proofs()
            .merge(
                &fee_tx(
                    fee_intent(
                        spend,
                        Timestamp::from_secs(NOW),
                        Timestamp::from_secs(NOW + 3600),
                    ),
                    segment,
                    "undeployed",
                )
                .erase_proofs(),
            )
            .expect("merge");
        let with_fee = merged
            .fees_with_margin(&INITIAL_PARAMETERS, 2)
            .expect("price the merged");
        assert!(
            with_fee > base_fee,
            "pricing the base alone ({base_fee}) must undercount the transaction that ships ({with_fee}) — \
             otherwise the second pass is pointless"
        );
    }

    /// ⚠️ **The reason pricing has to iterate.** `u128` serializes through `ScaleBigInt` — SCALE
    /// *compact*, one to seventeen bytes by magnitude — so the fee's own size depends on the fee, and
    /// a transaction priced while carrying a trial spend of 1 is cheaper than the one that ships.
    ///
    /// This test was first written asserting the opposite, that a `DustSpend`'s fields were all
    /// fixed-width and one pass was exact. It failed on its first run, 0.017% apart, which is the
    /// distance between a submission and `InsufficientDustToPayFees`.
    #[test]
    fn the_price_moves_with_the_fee_the_spend_carries() {
        let base = a_transfer_by_someone_else();
        let state = funded_dust_state(&[5u8; 32], 5_000_000_000_000);
        let sk = crate::dust::secret_key(&[5u8; 32]);
        let segment = free_segment(&base).expect("a free segment");
        let price_for = |fee: u128| {
            let (_, spend) =
                crate::unshielded::spend_for_fee(&state, &sk, fee, Timestamp::from_secs(NOW))
                    .expect("a funded state can pay a fee");
            base.erase_proofs()
                .merge(
                    &fee_tx(
                        fee_intent(
                            spend,
                            Timestamp::from_secs(NOW),
                            Timestamp::from_secs(NOW + 3600),
                        ),
                        segment,
                        "undeployed",
                    )
                    .erase_proofs(),
                )
                .expect("merge")
                .fees_with_margin(&INITIAL_PARAMETERS, 2)
                .expect("price")
        };
        assert!(
            price_for(999_999_999_999) > price_for(1),
            "a bigger fee is more bytes, so pricing with a trial spend of 1 undercharges the transaction that ships"
        );
    }

    /// The fixed point the loop in [`pay_fee_from_dust_json`] climbs to: a spend that covers the price
    /// of the transaction carrying *that* spend. Reproduced here because the loop itself only runs
    /// under proving, and this is the part of it that has nothing to do with proofs.
    #[test]
    fn the_fee_settles_at_a_spend_that_covers_its_own_transaction() {
        let base = a_transfer_by_someone_else();
        let state = funded_dust_state(&[5u8; 32], 5_000_000_000_000);
        let sk = crate::dust::secret_key(&[5u8; 32]);
        let segment = free_segment(&base).expect("a free segment");
        let price_with = |owed: u128| {
            let (_, spend) =
                crate::unshielded::spend_for_fee(&state, &sk, owed, Timestamp::from_secs(NOW))
                    .expect("a funded state can pay a fee");
            base.erase_proofs()
                .merge(
                    &fee_tx(
                        fee_intent(
                            spend,
                            Timestamp::from_secs(NOW),
                            Timestamp::from_secs(NOW + 3600),
                        ),
                        segment,
                        "undeployed",
                    )
                    .erase_proofs(),
                )
                .expect("merge")
                .fees_with_margin(&INITIAL_PARAMETERS, 2)
                .expect("price")
        };

        let mut owed = dust_owed(
            &base,
            base.fees_with_margin(&INITIAL_PARAMETERS, 2)
                .expect("base price"),
        )
        .expect("what the base owes");
        let mut rounds = 0;
        loop {
            let need =
                dust_owed(&base, price_with(owed)).expect("what the merged transaction owes");
            rounds += 1;
            if need <= owed {
                break;
            }
            owed = need;
            assert!(
                rounds < PRICING_ROUNDS,
                "pricing must converge inside its own budget"
            );
        }
        assert!(
            rounds > 1,
            "one round would mean the first estimate already covered it, and it does not"
        );
        assert!(
            price_with(owed) <= owed,
            "the settled spend must cover the transaction it produces, or the node refuses it"
        );
    }
}
