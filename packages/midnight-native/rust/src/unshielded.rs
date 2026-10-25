//! Native assembly of an unshielded NIGHT transfer — proven, signed, and unbound, ready for the
//! sponsor to merge a fee into.
//!
//! This is the send counterpart to [`crate::wallet`]'s shielded transfer, and it is far smaller: an
//! unshielded transfer carries no contract action and no Zswap offer, so **there is nothing to
//! prove**. `Transaction::prove` only walks `actions`, `dust_actions` and the coin offers (see
//! `midnight_ledger::prove`), all of which are empty here, so the proving step is a type transition
//! from `ProofPreimageMarker` to `ProofMarker` and the provider is never asked for a key. No SRS, no
//! prover key, no artifacts to download — which is what makes a send viable on a phone that has
//! synced nothing.
//!
//! What the device still owns is the part that cannot be delegated: choosing the inputs, conserving
//! value into a change output, and **signing**. The signature covers this intent alone
//! (`data_to_sign(segment_id)` over the proof- and signature-erased intent), which is exactly why a
//! third party can pay the fee for a transfer it did not author — the sponsor's balancing lives in a
//! separate segment and cannot alter ours without invalidating it.
//!
//! The transaction is left **unbound** (`PedersenRandomness`, not a finalized Pedersen commitment).
//! Binding covers the whole transaction and is irreversible, so binding here would produce bytes
//! nobody can attach a fee to — the sponsor rejects them as "not a proven-unbound transaction".

use midnight_base_crypto::signatures::{Signature, SigningKey};
use midnight_base_crypto::time::Timestamp;
use midnight_coin_structure::coin::{UnshieldedTokenType, UserAddress};
use midnight_ledger::dust::{
    DustActions, DustLocalState, DustSecretKey, DustSpend, QualifiedDustOutput,
};
use midnight_ledger::structure::INITIAL_PARAMETERS;
use midnight_ledger::structure::{
    Intent, IntentHash, ProofPreimageMarker, Transaction, UnshieldedOffer, UtxoOutput, UtxoSpend,
};
use midnight_onchain_runtime::cost_model::INITIAL_COST_MODEL;
use midnight_serialize::{tagged_deserialize, tagged_serialize, Serializable};
use midnight_storage::storage::HashMap as StorageHashMap;
use midnight_transient_crypto::commitment::PedersenRandomness;
use midnight_transient_crypto::curve::Fr;
use midnight_transient_crypto::proofs::{Proof, ProofPreimage, ProvingProvider};
use midnight_zkir::LocalProvingProvider;
use rand::rngs::OsRng;

use futures::executor::block_on;

use crate::state_read::DB;

/// Transfers live in segment 1; segment 0 is the guaranteed segment and an intent placed there is
/// rejected outright (`IntentAtGuaranteedSegmentId`).
const TRANSFER_SEGMENT: u16 = 1;

type UnprovenIntent = Intent<Signature, ProofPreimageMarker, PedersenRandomness, DB>;
type UnprovenTx = Transaction<Signature, ProofPreimageMarker, PedersenRandomness, DB>;

/// One unspent output to spend, as the indexer reports it.
///
/// The owner is deliberately absent: `UtxoSpend` needs the full `VerifyingKey`, while the indexer
/// reports the *address* (its hash). The device derives the verifying key from the same role key it
/// signs with, so taking an owner from the caller would only create a way for the two to disagree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnshieldedInput {
    pub value: u128,
    pub token_type: [u8; 32],
    pub intent_hash: [u8; 32],
    pub output_no: u32,
}

/// Everything needed to build one transfer. Fees are not here: they are the sponsor's segment.
#[derive(Debug, Clone)]
pub struct UnshieldedTransferRequest<'a> {
    /// The role-0 (Night) key: both the signing key and, through its verifying key, the owner of
    /// every input and the address change returns to.
    pub night_role_key: &'a [u8; 32],
    pub inputs: &'a [UnshieldedInput],
    /// The recipient's `UserAddress` payload — the 32 bytes inside an `mn_addr…` address.
    pub recipient_address: [u8; 32],
    pub token_type: [u8; 32],
    pub value: u128,
    pub network_id: &'a str,
    /// Absolute expiry, unix seconds. Far-future values are rejected at submission as
    /// `1010: Invalid Transaction: Custom error: 182`, which names nothing; an hour is safe.
    pub ttl_secs: u64,
    /// How many outputs to return change in. `0` or `1` keeps the single change output.
    ///
    /// The caller decides, because it is the side that knows how many UTxOs the wallet holds and what a
    /// chunk has to be worth to back a DUST generation that can cover a fee. See {@link split_change}.
    pub change_chunks: u32,
}

/// A provider for a transaction with nothing to prove.
///
/// `Transaction::prove` needs one, but with no contract actions, no dust actions and no coin offers
/// it only ever calls [`ProvingProvider::split`]. Both real methods fail loudly rather than
/// returning a placeholder proof: being asked to prove means the transaction is not the transfer
/// this module built, and a fabricated proof would turn that into a rejection at the node instead of
/// an error here.
pub(crate) struct NoCircuits;

impl ProvingProvider for NoCircuits {
    async fn check(&self, _preimage: &ProofPreimage) -> Result<Vec<Option<usize>>, anyhow::Error> {
        Err(anyhow::anyhow!(
            "an unshielded transfer has no circuit to check"
        ))
    }

    async fn prove(
        self,
        _preimage: &ProofPreimage,
        _overwrite_binding_input: Option<Fr>,
    ) -> Result<Proof, anyhow::Error> {
        Err(anyhow::anyhow!(
            "an unshielded transfer has no circuit to prove"
        ))
    }

    fn split(&mut self) -> Self {
        NoCircuits
    }
}

/// Build, sign and prove an unshielded transfer, returning the tagged bytes of a proven **unbound**
/// transaction — what `chain-client`'s sponsor path submits for balancing.
///
/// Inputs are spent in full and the remainder returns to the sender as a second output, because an
/// unshielded offer conserves value per token type: there is no fee to absorb a difference here, the
/// fee is DUST and lives in the sponsor's own segment.
pub fn build_unshielded_transfer_tx(
    request: UnshieldedTransferRequest<'_>,
) -> Result<Vec<u8>, String> {
    let signing_key = SigningKey::from_bytes(request.night_role_key)
        .map_err(|_| "malformed night role key".to_string())?;
    let (offer, signing_keys) = transfer_offer(&request, &signing_key)?;

    let intent = sign_transfer_intent(&request, offer, &signing_keys, None)?;
    let intents = StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(TRANSFER_SEGMENT, intent);
    let tx = UnprovenTx::from_intents(request.network_id.to_string(), intents);

    let proven = block_on(tx.prove(NoCircuits, &INITIAL_COST_MODEL))
        .map_err(|e| format!("prove transfer: {e:?}"))?;

    let mut bytes = Vec::new();
    tagged_serialize(&proven, &mut bytes).map_err(|e| format!("serialize transfer: {e}"))?;
    Ok(bytes)
}

/// The transfer's offer, sorted and validated — the half both builders share.
///
/// Extracted so the sponsored and self-funded paths cannot drift in what they spend: a difference in
/// input selection or change would only ever show up on chain.
fn transfer_offer(
    request: &UnshieldedTransferRequest<'_>,
    signing_key: &SigningKey,
) -> Result<(UnshieldedOffer<Signature, DB>, Vec<SigningKey>), String> {
    if request.value == 0 {
        return Err("refusing to build a transfer of zero".into());
    }
    if request.inputs.is_empty() {
        return Err("no inputs to spend".into());
    }
    let owner = signing_key.verifying_key();
    let token = UnshieldedTokenType(midnight_base_crypto::hash::HashOutput(request.token_type));

    if let Some(wrong) = request
        .inputs
        .iter()
        .find(|i| i.token_type != request.token_type)
    {
        return Err(format!(
            "input {}:{} is token {} but the transfer is of token {}",
            hex_32(&wrong.intent_hash),
            wrong.output_no,
            hex_32(&wrong.token_type),
            hex_32(&request.token_type),
        ));
    }

    let available: u128 = request.inputs.iter().map(|i| i.value).sum();
    let change = available.checked_sub(request.value).ok_or_else(|| {
        format!(
            "inputs hold {available} but the transfer needs {}",
            request.value
        )
    })?;

    let mut inputs: Vec<UtxoSpend> = request
        .inputs
        .iter()
        .map(|i| UtxoSpend {
            value: i.value,
            owner: owner.clone(),
            type_: token,
            intent_hash: IntentHash(midnight_base_crypto::hash::HashOutput(i.intent_hash)),
            output_no: i.output_no,
        })
        .collect();
    inputs.sort();
    if inputs.windows(2).any(|w| w[0] == w[1]) {
        return Err("the same output was given twice as an input".into());
    }

    let mut outputs = vec![UtxoOutput {
        value: request.value,
        owner: UserAddress(midnight_base_crypto::hash::HashOutput(
            request.recipient_address,
        )),
        type_: token,
    }];
    for value in split_change(change, request.change_chunks) {
        outputs.push(UtxoOutput {
            value,
            owner: UserAddress::from(owner.clone()),
            type_: token,
        });
    }
    // ⚠️ `UnshieldedOffer::well_formed` rejects unsorted outputs and the node runs that check, so this
    // is part of the format rather than tidiness — and it matters more now there can be several.
    outputs.sort();

    let signing_keys: Vec<SigningKey> = inputs.iter().map(|_| signing_key.clone()).collect();
    Ok((
        UnshieldedOffer::<Signature, DB> {
            inputs: inputs.into(),
            outputs: outputs.into(),
            signatures: vec![].into(),
        },
        signing_keys,
    ))
}

/// Build and sign the transfer intent, optionally carrying a dust action that pays its own fee.
///
/// ⚠️ **The dust action must be here, not added later.** `Intent::sign` signs the whole erased intent,
/// so attaching a `DustActions` afterwards voids the signature — which is why a self-funded transfer is
/// a different build order rather than a step appended to a finished one.
fn sign_transfer_intent(
    request: &UnshieldedTransferRequest<'_>,
    offer: UnshieldedOffer<Signature, DB>,
    signing_keys: &[SigningKey],
    dust_actions: Option<DustActions<Signature, ProofPreimageMarker, DB>>,
) -> Result<UnprovenIntent, String> {
    let intent: UnprovenIntent = UnprovenIntent::new(
        &mut OsRng,
        None,
        Some(offer),
        vec![],
        vec![],
        vec![],
        dust_actions,
        Timestamp::from_secs(request.ttl_secs),
    );
    // Signing before proving is not an ordering accident: `Intent::sign` computes the payload from
    // the proof-erased intent, so the signature is indifferent to the proof marker, and the offers
    // (signatures included) pass through `prove` unchanged.
    intent
        .sign(&mut OsRng, TRANSFER_SEGMENT, &[], signing_keys, &[])
        .map_err(|e| format!("sign transfer intent: {e:?}"))
}

fn hex_32(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// One packed input record: `value` (u128 LE, 16) ‖ `token_type` (32) ‖ `intent_hash` (32) ‖
/// `output_no` (u32 LE, 4).
///
/// Fixed-width records rather than JSON because this crate carries no parser, and because a
/// length-prefixed variable encoding would put a second failure mode (a truncated record read as a
/// short one) where a divisibility check suffices.
///
/// Must equal `INPUT_RECORD_LEN` in `src/unshielded-wire.ts`, which writes the records.
pub const INPUT_RECORD_LEN: usize = 84;

/// Decode a packed input array. Rejects a trailing partial record rather than ignoring it: a
/// dropped input is a transfer built from less money than the caller selected, which fails at the
/// node with nothing naming the cause.
pub fn decode_input_records(packed: &[u8]) -> Result<Vec<UnshieldedInput>, String> {
    if packed.len() % INPUT_RECORD_LEN != 0 {
        return Err(format!(
            "packed inputs are {} bytes, not a whole number of {INPUT_RECORD_LEN}-byte records",
            packed.len()
        ));
    }
    Ok(packed
        .chunks_exact(INPUT_RECORD_LEN)
        .map(|r| UnshieldedInput {
            value: u128::from_le_bytes(r[0..16].try_into().expect("16 bytes")),
            token_type: r[16..48].try_into().expect("32 bytes"),
            intent_hash: r[48..80].try_into().expect("32 bytes"),
            output_no: u32::from_le_bytes(r[80..84].try_into().expect("4 bytes")),
        })
        .collect())
}

/// [`build_unshielded_transfer_tx`] for the bridges: packed/fixed-width in, hex out.
///
/// Hex rather than raw bytes on the way out to match every other builder on this rail — the JNI and
/// C ABIs marshal strings, and a bytes-in/hex-out mismatch fails at a boundary no host test covers.
#[allow(clippy::too_many_arguments)]
pub fn build_unshielded_transfer_hex(
    night_role_key: &[u8; 32],
    packed_inputs: &[u8],
    recipient_address: &[u8; 32],
    token_type: &[u8; 32],
    value_le: &[u8; 16],
    network_id: &str,
    ttl_secs: u64,
    change_chunks: u32,
) -> Result<String, String> {
    let inputs = decode_input_records(packed_inputs)?;
    let tx = build_unshielded_transfer_tx(UnshieldedTransferRequest {
        night_role_key,
        inputs: &inputs,
        recipient_address: *recipient_address,
        token_type: *token_type,
        value: u128::from_le_bytes(*value_le),
        network_id,
        ttl_secs,
        change_chunks,
    })?;
    Ok(tx.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod change_splitting {
    use super::split_change;

    #[test]
    fn one_chunk_is_the_default_and_zero_means_the_same() {
        assert_eq!(split_change(100, 0), vec![100]);
        assert_eq!(split_change(100, 1), vec![100]);
    }

    #[test]
    fn nothing_to_return_produces_no_output() {
        // Not a zero-valued output: a change output of 0 is a leaf the ledger has no reason to carry.
        assert_eq!(split_change(0, 8), Vec::<u128>::new());
    }

    #[test]
    fn the_sum_is_exact_and_the_remainder_lands_on_the_first() {
        // Every atomic unit is conserved. Spreading a remainder would need fractional units, and
        // dropping it would burn value the transaction was conserving.
        let chunks = split_change(103, 5);
        assert_eq!(chunks, vec![23, 20, 20, 20, 20]);
        assert_eq!(chunks.iter().sum::<u128>(), 103);
    }

    #[test]
    fn a_change_smaller_than_the_chunk_count_stays_whole() {
        // Splitting 3 into 8 would mean five zero-valued outputs.
        assert_eq!(split_change(3, 8), vec![3]);
    }
}

#[cfg(test)]
mod fee_candidate_order {
    use super::order_fee_candidates;
    use midnight_base_crypto::hash::HashOutput;
    use midnight_base_crypto::time::Timestamp;
    use midnight_ledger::dust::{DustPublicKey, InitialNonce, QualifiedDustOutput};
    use midnight_transient_crypto::curve::Fr;

    fn out(seq: u32, initial_value: u128) -> QualifiedDustOutput {
        QualifiedDustOutput {
            initial_value,
            // The owner and nonce play no part in the ordering, so one value serves for all of them.
            owner: DustPublicKey(Fr::from(1u64)),
            nonce: Fr::from(1u64),
            seq,
            ctime: Timestamp::from_secs(1_700_000_000),
            backing_night: InitialNonce(HashOutput([1u8; 32])),
            mt_index: 0,
        }
    }

    /// ⚠️ The rule that stops one output absorbing every fee. Repairing a spend takes one sync pass per
    /// link, and passes advance every chain at once — so the cost is the *longest* chain, and spreading
    /// fees across outputs is what keeps it at one.
    #[test]
    fn the_shallowest_output_is_tried_first_even_when_it_is_smaller() {
        let mut candidates = vec![out(3, 1_000_000), out(0, 5), out(1, 900_000)];
        order_fee_candidates(&mut candidates);
        assert_eq!(
            candidates.iter().map(|c| c.seq).collect::<Vec<_>>(),
            vec![0, 1, 3],
            "a fee must not keep landing on the output that has already paid the most"
        );
    }

    #[test]
    fn the_largest_wins_within_one_seq_so_a_fee_is_likely_covered_first_try() {
        let mut candidates = vec![out(2, 10), out(2, 900), out(2, 400)];
        order_fee_candidates(&mut candidates);
        assert_eq!(
            candidates
                .iter()
                .map(|c| c.initial_value)
                .collect::<Vec<_>>(),
            vec![900, 400, 10],
            "within a depth, try the one most likely to cover the fee"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use midnight_ledger::structure::INITIAL_PARAMETERS;
    use std::ops::Deref;

    use bip32::{DerivationPath, XPrv};
    use bip39::Mnemonic;
    use midnight_ledger::structure::ProofMarker;
    use midnight_serialize::tagged_deserialize;

    /// NIGHT: the unshielded native token is 32 zero bytes.
    const NIGHT: [u8; 32] = [0u8; 32];

    /// Role 0 is Night — the key that both signs an unshielded spend and names its owner. Derived
    /// rather than pasted so these tests are pinned to the wallet the app derives.
    fn night_role_key() -> [u8; 32] {
        let seed = Mnemonic::parse("test test test test test test test test test test test junk")
            .unwrap()
            .to_seed("");
        let path: DerivationPath = "m/44'/2400'/0'/0/0".parse().unwrap();
        XPrv::derive_from_path(&seed, &path)
            .unwrap()
            .private_key()
            .to_bytes()
            .into()
    }

    fn input(value: u128, output_no: u32) -> UnshieldedInput {
        UnshieldedInput {
            value,
            token_type: NIGHT,
            intent_hash: [output_no as u8 + 1; 32],
            output_no,
        }
    }

    fn request<'a>(
        key: &'a [u8; 32],
        inputs: &'a [UnshieldedInput],
        value: u128,
    ) -> UnshieldedTransferRequest<'a> {
        UnshieldedTransferRequest {
            night_role_key: key,
            inputs,
            recipient_address: [9u8; 32],
            token_type: NIGHT,
            value,
            network_id: "preprod",
            ttl_secs: 1_800_000_000,
            // One change output, which is what the existing assertions describe. The split has its own
            // tests in `change_splitting`.
            change_chunks: 1,
        }
    }

    type ProvenTx = Transaction<Signature, ProofMarker, PedersenRandomness, DB>;

    fn deserialize(bytes: &[u8]) -> ProvenTx {
        tagged_deserialize(&mut &bytes[..]).expect("proven transfer deserializes")
    }

    fn offer_of(
        tx: &ProvenTx,
    ) -> (
        UnshieldedOffer<Signature, DB>,
        Intent<Signature, ProofMarker, PedersenRandomness, DB>,
    ) {
        let Transaction::Standard(stx) = tx else {
            panic!("expected a standard transaction")
        };
        let intent = stx
            .intents
            .get(&TRANSFER_SEGMENT)
            .expect("segment 1 intent")
            .deref()
            .clone();
        let offer = intent
            .fallible_unshielded_offer
            .as_ref()
            .expect("a transfer carries a guaranteed unshielded offer")
            .deref()
            .clone();
        (offer, intent)
    }

    /// **How many inputs a transfer may carry.** Not a guess: `Transaction::fees(params, true)` runs
    /// the node's own dismiss-time rule, which is what rejected a real 46-input transfer on preprod
    /// as `1010: Invalid Transaction: Custom error: 168` (`MalformedError::FeeCalculation`).
    ///
    /// The rule is `max(time_to_dismiss_per_byte * est_size, min_time_to_dismiss)` against the cost
    /// to dismiss, in synthetic cost units rather than measured time. Measured here: the cost is
    /// **application compute at ~2.4 ms per input** — spending an output is a state write — while an
    /// input's ~181 bytes buy only ~0.36 ms of allowance. Cost outruns allowance ~6.6x, so there is a
    /// ceiling and no size at which it relaxes. Signature verification is ~59 µs and not the driver.
    ///
    /// Printed rather than asserted at a fixed number: it is a property of the ledger parameters, and
    /// pinning it here would turn a parameter change into a mysterious test failure.
    #[test]
    fn how_many_inputs_fit_inside_the_dismiss_budget() {
        let key = night_role_key();
        let mut last_ok = 0usize;
        let mut first_bad: Option<(usize, String)> = None;
        for count in 1..=48usize {
            let inputs: Vec<UnshieldedInput> =
                (0..count).map(|i| input(1_000_000, i as u32)).collect();
            let value = 1_000_000u128 * count as u128;
            let bytes =
                build_unshielded_transfer_tx(request(&key, &inputs, value)).expect("builds");
            let tx = deserialize(&bytes);
            match tx.fees(&INITIAL_PARAMETERS, true) {
                Ok(_) => last_ok = count,
                Err(error) => {
                    first_bad = Some((count, format!("{error}")));
                    break;
                }
            }
        }
        // What actually grows, and by how much. Signature verification is ~59 µs / 4 (the model's
        // parallelism factor), which is far too small to explain the step at the ceiling — so print
        // the components rather than reason about them.
        for count in [1usize, 2, 4, 5, 8] {
            let inputs: Vec<UnshieldedInput> =
                (0..count).map(|i| input(1_000_000, i as u32)).collect();
            let bytes =
                build_unshielded_transfer_tx(request(&key, &inputs, 1_000_000u128 * count as u128))
                    .expect("builds");
            let tx = deserialize(&bytes);
            let model = &INITIAL_PARAMETERS.cost_model;
            let validation = tx.validation_cost(model);
            let (guaranteed, _application) = tx.application_cost(model);
            println!(
                "n={count} wire={} bytes  dismiss={:?}  validation(compute={:?} read={:?})  guaranteed(compute={:?} read={:?})",
                bytes.len(),
                tx.time_to_dismiss(model),
                validation.compute_time,
                validation.read_time,
                guaranteed.compute_time,
                guaranteed.read_time,
            );
        }
        println!("largest input count the dismiss budget allows: {last_ok}");
        if let Some((count, error)) = &first_bad {
            println!("first rejected count: {count} -> {error}");
        }
        assert!(last_ok >= 1, "a single-input transfer must fit");
    }

    /// The load-bearing test: the ledger's own well-formedness check is what the node runs, and it
    /// covers input sorting, duplicate inputs, the signature *count* — the s60 sponsor bug — and
    /// signature verification against this intent's own data-to-sign.
    #[test]
    fn the_ledger_calls_the_built_transfer_well_formed() {
        let key = night_role_key();
        let inputs = [input(1_000_000, 0), input(2_500_000, 1)];
        let bytes =
            build_unshielded_transfer_tx(request(&key, &inputs, 3_000_000)).expect("builds");

        let tx = deserialize(&bytes);
        let (offer, intent) = offer_of(&tx);
        let erased = intent.erase_proofs().erase_signatures();
        let verify = offer
            .well_formed(TRANSFER_SEGMENT, &erased)
            .expect("offer is well formed");
        verify().expect("signatures verify");
    }

    /// ⚠️ The point of splitting at all: several NIGHT UTxOs mean several DUST generations, and a fee
    /// must be covered by a *single* DUST output. Asserted through the real builder because the offer's
    /// output ordering is part of the wire format the node checks.
    #[test]
    fn change_can_come_back_in_several_outputs_that_still_conserve_value() {
        let key = night_role_key();
        let inputs = [input(1_000_000, 0), input(9_000_000, 1)];
        let mut req = request(&key, &inputs, 1_000_000);
        req.change_chunks = 4;
        let bytes = build_unshielded_transfer_tx(req).expect("builds");

        let (offer, intent) = offer_of(&deserialize(&bytes));
        let outputs = Vec::from(&offer.outputs);
        assert_eq!(
            outputs.len(),
            5,
            "one recipient output and four change outputs"
        );
        assert_eq!(
            outputs.iter().map(|o| o.value).sum::<u128>(),
            10_000_000,
            "every atomic unit is still accounted for"
        );
        let recipient = UserAddress(midnight_base_crypto::hash::HashOutput([9u8; 32]));
        let change: Vec<u128> = outputs
            .iter()
            .filter(|o| o.owner != recipient)
            .map(|o| o.value)
            .collect();
        assert_eq!(change.len(), 4, "four outputs came back to us");
        assert_eq!(
            change.iter().sum::<u128>(),
            9_000_000,
            "the change is whole"
        );

        // `well_formed` is what the node runs, so a multi-output offer has to survive it. The output
        // *ordering* it also enforces is pinned by the sibling tests, not here: these chunk values
        // happen to be in sorted order already, so this assertion would not notice a missing sort.
        let erased = intent.erase_proofs().erase_signatures();
        let verify = offer
            .well_formed(TRANSFER_SEGMENT, &erased)
            .expect("offer with several change outputs is well formed");
        verify().expect("signatures verify");
    }

    #[test]
    fn value_is_conserved_and_change_returns_to_the_sender() {
        let key = night_role_key();
        let inputs = [input(1_000_000, 0), input(2_500_000, 1)];
        let bytes =
            build_unshielded_transfer_tx(request(&key, &inputs, 3_000_000)).expect("builds");

        let (offer, _) = offer_of(&deserialize(&bytes));
        let outputs = Vec::from(&offer.outputs);
        assert_eq!(
            outputs.len(),
            2,
            "one recipient output and one change output"
        );
        assert_eq!(
            outputs.iter().map(|o| o.value).sum::<u128>(),
            3_500_000,
            "outputs total the inputs spent"
        );

        let recipient = outputs
            .iter()
            .find(|o| o.value == 3_000_000)
            .expect("the recipient's output");
        assert_eq!(recipient.owner.0 .0, [9u8; 32]);

        let ours = UserAddress::from(SigningKey::from_bytes(&key).unwrap().verifying_key());
        let change = outputs
            .iter()
            .find(|o| o.value == 500_000)
            .expect("the change output");
        assert_eq!(
            change.owner, ours,
            "change returns to the address the inputs came from"
        );
    }

    #[test]
    fn an_exact_spend_has_no_change_output() {
        let key = night_role_key();
        let inputs = [input(3_000_000, 0)];
        let bytes =
            build_unshielded_transfer_tx(request(&key, &inputs, 3_000_000)).expect("builds");

        let (offer, _) = offer_of(&deserialize(&bytes));
        assert_eq!(
            Vec::from(&offer.outputs).len(),
            1,
            "no dust-sized change output for an exact spend"
        );
    }

    /// Inputs handed over in any order must come out sorted, because `well_formed` rejects the
    /// alternative and the caller reads its UTxOs from an indexer that promises no ordering.
    #[test]
    fn inputs_are_sorted_however_they_arrive() {
        let key = night_role_key();
        let inputs = [
            input(9_000_000, 7),
            input(1_000_000, 2),
            input(5_000_000, 4),
        ];
        let bytes =
            build_unshielded_transfer_tx(request(&key, &inputs, 1_000_000)).expect("builds");

        let (offer, intent) = offer_of(&deserialize(&bytes));
        assert!(Vec::from(&offer.inputs).is_sorted(), "inputs are sorted");
        let erased = intent.erase_proofs().erase_signatures();
        offer
            .well_formed(TRANSFER_SEGMENT, &erased)
            .expect("well formed")()
        .expect("signatures verify");
    }

    /// **Can two wallets fund one payment together?** — the shape Cardano's co-funded send has and
    /// Midnight has not (`docs/MIDNIGHT_COFUNDING_PLAN.md`, shape C).
    ///
    /// `balance.rs` refuses to *extend* an intent that already carries inputs, because adding inputs
    /// voids the signatures already there. That is a statement about **order**, not permission: the
    /// question this answers is whether an offer whose inputs belong to two different owners can be
    /// signed by both and pass `well_formed` — i.e. whether shape C is a gather-then-sign protocol we
    /// can write, or something the ledger will not represent.
    ///
    /// ⚠️ The signing keys must be in **input order**, and inputs sort by value/owner — so the offer
    /// has to be final before anyone signs. That ordering *is* the protocol.
    #[test]
    fn two_owners_can_fund_one_offer_together() {
        let key_a = SigningKey::from_bytes(&night_role_key()).expect("key a");
        // A second, unrelated wallet: a different derivation path, as another person's would be.
        let seed = Mnemonic::parse("test test test test test test test test test test test junk")
            .unwrap()
            .to_seed("");
        let path: DerivationPath = "m/44'/2400'/1'/0/0".parse().unwrap();
        let bytes_b: [u8; 32] = XPrv::derive_from_path(&seed, &path)
            .unwrap()
            .private_key()
            .to_bytes()
            .into();
        let key_b = SigningKey::from_bytes(&bytes_b).expect("key b");
        assert_ne!(
            key_a.verifying_key(),
            key_b.verifying_key(),
            "two distinct owners"
        );

        let token = UnshieldedTokenType(midnight_base_crypto::hash::HashOutput(NIGHT));
        let spend = |value: u128, owner: &SigningKey, n: u32| UtxoSpend {
            value,
            owner: owner.verifying_key(),
            type_: token,
            intent_hash: IntentHash(midnight_base_crypto::hash::HashOutput([n as u8 + 1; 32])),
            output_no: n,
        };

        // One payment, funded by both wallets: 2 NIGHT each toward a 4 NIGHT output.
        let mut inputs = vec![spend(2_000_000, &key_a, 0), spend(2_000_000, &key_b, 1)];
        inputs.sort();
        // The keys must follow the sorted inputs, owner for owner — this is what a composer has to
        // get right when it gathers signatures from separate parties.
        let keys: Vec<SigningKey> = inputs
            .iter()
            .map(|i| {
                if i.owner == key_a.verifying_key() {
                    key_a.clone()
                } else {
                    key_b.clone()
                }
            })
            .collect();

        let outputs = vec![UtxoOutput {
            value: 4_000_000,
            owner: UserAddress(midnight_base_crypto::hash::HashOutput([9u8; 32])),
            type_: token,
        }];
        let offer = UnshieldedOffer::<Signature, DB> {
            inputs: inputs.into(),
            outputs: outputs.into(),
            signatures: vec![].into(),
        };

        let intent: UnprovenIntent = UnprovenIntent::new(
            &mut OsRng,
            None,
            Some(offer),
            vec![],
            vec![],
            vec![],
            None,
            Timestamp::from_secs(1_800_000_000),
        );
        let signed = intent
            .sign(&mut OsRng, TRANSFER_SEGMENT, &[], &keys, &[])
            .expect("an offer owned by two wallets signs");

        let signed_offer = signed
            .fallible_unshielded_offer
            .as_ref()
            .expect("offer")
            .deref()
            .clone();
        assert_eq!(
            signed_offer.signatures.len(),
            2,
            "one signature per input, one owner each"
        );
        let erased = signed.erase_proofs().erase_signatures();
        signed_offer
            .well_formed(TRANSFER_SEGMENT, &erased)
            .expect("well formed")()
        .expect("both owners' signatures verify");
    }

    #[test]
    fn every_input_gets_its_own_signature() {
        let key = night_role_key();
        let inputs = [
            input(1_000_000, 0),
            input(1_000_000, 1),
            input(1_000_000, 2),
        ];
        let bytes =
            build_unshielded_transfer_tx(request(&key, &inputs, 2_500_000)).expect("builds");

        let (offer, _) = offer_of(&deserialize(&bytes));
        assert_eq!(
            offer.signatures.len(),
            offer.inputs.len(),
            "one signature per input, as the node counts them"
        );
    }

    #[test]
    fn refuses_inputs_that_do_not_cover_the_amount() {
        let key = night_role_key();
        let inputs = [input(1_000_000, 0)];
        let err = build_unshielded_transfer_tx(request(&key, &inputs, 2_000_000))
            .expect_err("cannot overspend");
        assert!(
            err.contains("inputs hold 1000000"),
            "the error names both figures: {err}"
        );
    }

    /// The expensive mistake this guards: spending a non-NIGHT UTxO would fold its value into NIGHT
    /// change, destroying the token rather than failing.
    #[test]
    fn refuses_an_input_of_another_token() {
        let key = night_role_key();
        let mut other = input(5_000_000, 1);
        other.token_type = [3u8; 32];
        let inputs = [input(1_000_000, 0), other];
        let err = build_unshielded_transfer_tx(request(&key, &inputs, 1_000_000))
            .expect_err("mixed tokens");
        assert!(
            err.contains("is token 0303"),
            "the error names the offending token: {err}"
        );
    }

    #[test]
    fn refuses_the_same_output_twice() {
        let key = night_role_key();
        let inputs = [input(2_000_000, 0), input(2_000_000, 0)];
        let err = build_unshielded_transfer_tx(request(&key, &inputs, 1_000_000))
            .expect_err("duplicate input");
        assert!(err.contains("twice"), "{err}");
    }

    #[test]
    fn refuses_a_transfer_of_nothing() {
        let key = night_role_key();
        let inputs = [input(1_000_000, 0)];
        build_unshielded_transfer_tx(request(&key, &inputs, 0)).expect_err("zero transfer");
    }

    fn pack(inputs: &[UnshieldedInput]) -> Vec<u8> {
        let mut out = Vec::new();
        for i in inputs {
            out.extend_from_slice(&i.value.to_le_bytes());
            out.extend_from_slice(&i.token_type);
            out.extend_from_slice(&i.intent_hash);
            out.extend_from_slice(&i.output_no.to_le_bytes());
        }
        out
    }

    #[test]
    fn the_packed_entry_point_decodes_what_the_host_packed() {
        let key = night_role_key();
        let inputs = [input(1_000_000, 0), input(2_500_000, 1)];
        let hex = build_unshielded_transfer_hex(
            &key,
            &pack(&inputs),
            &[9u8; 32],
            &NIGHT,
            &3_000_000u128.to_le_bytes(),
            "preprod",
            1_800_000_000,
            1,
        )
        .expect("builds from packed inputs");

        let bytes: Vec<u8> = (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("hex"))
            .collect();
        let (offer, intent) = offer_of(&deserialize(&bytes));
        assert_eq!(offer.inputs.len(), 2, "both packed records became inputs");
        let erased = intent.erase_proofs().erase_signatures();
        offer
            .well_formed(TRANSFER_SEGMENT, &erased)
            .expect("well formed")()
        .expect("signatures verify");
    }

    /// A truncated record must fail, not silently spend fewer inputs than the caller selected.
    #[test]
    fn refuses_a_partial_input_record() {
        let key = night_role_key();
        let mut packed = pack(&[input(1_000_000, 0), input(2_000_000, 1)]);
        packed.truncate(packed.len() - 3);
        let err = build_unshielded_transfer_hex(
            &key,
            &packed,
            &[9u8; 32],
            &NIGHT,
            &1_000_000u128.to_le_bytes(),
            "preprod",
            1_800_000_000,
            1,
        )
        .expect_err("truncated record");
        assert!(err.contains("whole number of 84-byte records"), "{err}");
    }

    #[test]
    fn refuses_a_malformed_role_key() {
        let inputs = [input(1_000_000, 0)];
        let zero = [0u8; 32];
        build_unshielded_transfer_tx(request(&zero, &inputs, 500_000))
            .expect_err("zero is not a valid schnorr key");
    }

    /// A transfer's identifiers exist, are stable, and are what a caller can track it by.
    ///
    /// The hash cannot serve: the sponsor merges its balancing into this transaction, which changes
    /// the hash by construction. These do not change.
    #[test]
    fn a_transfer_has_identifiers_and_they_survive_a_round_trip() {
        let key = night_role_key();
        let inputs = [input(1_000_000, 0)];
        let bytes = build_unshielded_transfer_tx(request(&key, &inputs, 400_000)).expect("builds");

        let ids = crate::tx::proven_tx_identifiers(&bytes).expect("identifiers");

        assert!(
            !ids.is_empty(),
            "a transfer with an intent must carry at least its binding commitment"
        );
        for id in &ids {
            assert_eq!(id.len() % 2, 0, "hex is whole bytes");
            assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "hex only: {id}");
        }
        // Re-reading the same bytes must give the same set, or nothing downstream can match on them.
        assert_eq!(
            crate::tx::proven_tx_identifiers(&bytes).expect("again"),
            ids
        );
    }

    /// Two different transfers must not share an identifier, or a match would be meaningless.
    #[test]
    fn different_transfers_have_different_identifiers() {
        let key = night_role_key();
        let a = build_unshielded_transfer_tx(request(&key, &[input(1_000_000, 0)], 400_000))
            .expect("a");
        let b = build_unshielded_transfer_tx(request(&key, &[input(1_000_000, 1)], 400_000))
            .expect("b");

        let ids_a = crate::tx::proven_tx_identifiers(&a).expect("ids a");
        let ids_b = crate::tx::proven_tx_identifiers(&b).expect("ids b");

        assert!(
            ids_a.iter().all(|id| !ids_b.contains(id)),
            "identifiers must distinguish transfers"
        );
    }

    /// The dump the TS cross-check reads. `proven_tx_identifiers` is only correct if its hex is the
    /// hex the indexer matches, and the authority for that is the TS ledger's own `identifiers()`.
    #[test]
    fn dump_a_transfer_and_its_identifiers_for_the_ts_cross_check() {
        let key = night_role_key();
        let inputs = [input(1_000_000, 0)];
        let bytes = build_unshielded_transfer_tx(request(&key, &inputs, 400_000)).expect("builds");
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        println!("TXHEX={hex}");
        for id in crate::tx::proven_tx_identifiers(&bytes).expect("identifiers") {
            println!("RUSTID={id}");
        }
    }
}

/// Everything a **self-funded** transfer needs beyond [`UnshieldedTransferRequest`].
#[derive(Debug, Clone)]
pub struct SelfFundedExtras<'a> {
    /// A synced `DustLocalState` — see [`crate::dust`]. Returned updated, with the spend pending.
    pub dust_state: &'a [u8],
    /// Role-1 (Dust) key: it owns the DUST outputs and authorises the spend.
    pub dust_role_key: &'a [u8; 32],
    /// The instant the fee is priced and the DUST valued at. Unix seconds.
    pub ctime_secs: u64,
    /// Holds `spend.{bzkir,prover,verifier}` for `midnight/dust/spend`.
    pub artifact_dir: &'a str,
    /// Holds `bls_midnight_2p13`.
    pub params_dir: &'a str,
    /// Margin exponent for `fees_with_margin`.
    pub fee_margin: usize,
}

/// Take enough DUST for `fee` from whichever output can cover it.
///
/// Tries the **shallowest** outputs first — lowest `seq`, and the largest value within a `seq`.
/// Deliberately not pre-computing each output's spendable value: that arithmetic is the generation
/// model, and `spend` already runs it and already fails with both figures
/// (`NotEnoughDust { available, required }`) — reimplementing it here would give a second opinion that
/// could disagree.
///
/// ⚠️ **Why `seq` and not value.** A spend writes a successor at `seq + 1`, and the per-address feed
/// does not carry successors, so a sync reinstates them by replaying each spend's own event — one step
/// per pass, because a successor's nullifier cannot be computed until the successor exists. The number
/// of passes is therefore the length of the **longest** chain, not the number of spends: every pass
/// advances all chains at once, so breadth is free and depth is not.
///
/// Sorting by value alone picked the same big output for every fee, giving one long chain. Measured on
/// preprod 2026-08-23: eight passes and still going, two outputs unwinding one link each per pass, at
/// ~2 minutes a pass. The same eight fees spread across eight outputs would be **one** pass.
///
/// One output, not several: `spend` takes one, and a fee needing two is a wallet whose DUST is spread
/// thin. That is reported rather than silently split, because splitting changes what the transaction
/// looks like and the caller should decide.
/// Shallowest first: lowest `seq`, largest value within a `seq`.
///
/// Its own function so it can be tested without a whole `DustLocalState` — `spend_for_fee` needs a
/// synced state and real artifacts, and its test skips without them.
/// Split a change amount into `chunks` outputs, largest first, or one output when it cannot usefully
/// be split.
///
/// ⚠️ **Why a wallet wants its NIGHT spread at all.** A DUST generation's rate *and* cap are
/// proportional to the value of the one NIGHT UTxO backing it (cap = value × `night_dust_ratio`), and a
/// fee must be covered by a **single** DUST output. So one large UTxO yields exactly one output that
/// can ever pay a fee, and a pile of unusable small ones — measured on preprod as "no single DUST
/// output covers a fee of 686161378353573 across 26 held". Several mid-sized UTxOs give several
/// payers, which is also what keeps any one output's spend history short.
///
/// Time to fill is unaffected: rate and cap are both proportional to the backing value, so N chunks
/// each reach their own cap in the same time one large output would.
///
/// The caller decides *how many* — it is the side that knows how many UTxOs the wallet already holds
/// and what a chunk must be worth to be useful. `0` and `1` both mean "do not split", so a caller that
/// has no opinion keeps the old single-change behaviour.
///
/// The remainder goes to the first chunk rather than being spread, so every output is a whole number of
/// atomic units and the sum is exactly `change` — a split that lost a unit would silently burn it.
fn split_change(change: u128, chunks: u32) -> Vec<u128> {
    if change == 0 {
        return Vec::new();
    }
    let n = u128::from(chunks.max(1));
    if n == 1 || change < n {
        return vec![change];
    }
    let base = change / n;
    let remainder = change % n;
    let mut out = Vec::with_capacity(chunks as usize);
    out.push(base + remainder);
    for _ in 1..n {
        out.push(base);
    }
    out
}

fn order_fee_candidates(candidates: &mut [QualifiedDustOutput]) {
    candidates.sort_by(|a, b| {
        a.seq
            .cmp(&b.seq)
            .then_with(|| b.initial_value.cmp(&a.initial_value))
    });
}

pub(crate) fn spend_for_fee(
    state: &DustLocalState<DB>,
    dust_sk: &DustSecretKey,
    fee: u128,
    ctime: Timestamp,
) -> Result<(DustLocalState<DB>, DustSpend<ProofPreimageMarker, DB>), String> {
    let mut candidates: Vec<QualifiedDustOutput> = state.utxos().collect();
    if candidates.is_empty() {
        return Err(format!(
            "this wallet holds no DUST outputs, so it cannot pay a fee of {fee} — sync DUST first, or let a sponsor pay"
        ));
    }
    order_fee_candidates(&mut candidates);

    let mut last: Option<String> = None;
    for utxo in &candidates {
        match state.spend(dust_sk, utxo, fee, ctime) {
            Ok(pair) => return Ok(pair),
            Err(e) => last = Some(format!("{e:?}")),
        }
    }
    Err(format!(
        "no single DUST output covers a fee of {fee} across {} held: {}",
        candidates.len(),
        last.unwrap_or_else(|| "no reason given".into()),
    ))
}

/// A self-funded transfer: proven, signed, **sealed**, and paying its own DUST fee.
///
/// ## Why this is its own builder
///
/// A `DustSpend` is `ProofPreimageMarker`, and `Intent::sign` signs the whole erased intent — so the
/// dust action has to be attached **before** signing and before proving. It cannot be bolted onto the
/// proven, unbound transaction [`build_unshielded_transfer_tx`] returns. The order is: price the fee,
/// take the DUST, build the intent *with* its dust action, sign, prove, seal.
///
/// ## The fee is priced on a transaction that does not exist yet
///
/// A fee depends on the transaction's size and the dust action that pays it makes the transaction
/// bigger, so the figure is circular. `fees_with_margin` is the ledger's own answer: price the
/// transfer, then multiply by `max_price_adjustment^margin`. The margin also absorbs the dust price
/// moving between building and inclusion, which it does every block.
///
/// ## ⚠️ A zero fee means no dust action at all, not an empty one
///
/// The dust price decays on an idle chain, so a genuinely-zero fee is normal. The node rejects a
/// transaction carrying an **empty** `DustActions` as `NotNormalized` — surfaced as
/// `1010: Invalid Transaction: Custom error: 117`. `chain-client`'s `balancing.ts` hit exactly this
/// live and drops such a section; so does this.
///
/// ## Sealing
///
/// A sponsored transfer goes out **unbound** because the sponsor binds it after merging its fee in.
/// Nobody does that here, so this seals — `PedersenRandomness` becomes `PureGeneratorPedersen` and the
/// result is submittable as-is. Sealing is the one step this rail has never taken before.
///
/// Returns JSON `{"tx","state","fee"}`: the sealed transaction, the dust state with its spend pending
/// (⚠️ **persist it** — otherwise the next transfer picks the same output), and the fee charged.
pub fn build_self_funded_transfer_json(
    request: UnshieldedTransferRequest<'_>,
    extras: SelfFundedExtras<'_>,
) -> Result<String, String> {
    let signing_key = SigningKey::from_bytes(request.night_role_key)
        .map_err(|_| "malformed night role key".to_string())?;
    let dust_sk = crate::dust::secret_key(extras.dust_role_key);
    let ctime = Timestamp::from_secs(extras.ctime_secs);

    let dust_state: DustLocalState<DB> = tagged_deserialize(&mut &extras.dust_state[..])
        .map_err(|e| format!("deserialize dust state: {e}"))?;

    // Pass one: the transfer alone, to price it. Signed, because `cost` walks the real bytes and an
    // unsigned intent is smaller than the one that ships.
    let (offer, signing_keys) = transfer_offer(&request, &signing_key)?;
    let priced = sign_transfer_intent(&request, offer.clone(), &signing_keys, None)?;
    let priced_tx = UnprovenTx::from_intents(
        request.network_id.to_string(),
        StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(TRANSFER_SEGMENT, priced),
    );
    let fee = priced_tx
        .fees_with_margin(&INITIAL_PARAMETERS, extras.fee_margin)
        .map_err(|e| format!("price the transfer's fee: {e:?}"))?;

    // Pass two: the real intent, carrying a dust action only when there is a fee to pay.
    let (next_dust_state, dust_actions) = if fee == 0 {
        (dust_state, None)
    } else {
        let (next, spend) = spend_for_fee(&dust_state, &dust_sk, fee, ctime)?;
        (
            next,
            Some(DustActions::<Signature, ProofPreimageMarker, DB> {
                spends: vec![spend].into(),
                registrations: vec![].into(),
                ctime,
            }),
        )
    };

    let intent = sign_transfer_intent(&request, offer, &signing_keys, dust_actions)?;
    let tx = UnprovenTx::from_intents(
        request.network_id.to_string(),
        StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(TRANSFER_SEGMENT, intent),
    );

    // Real proving now: the dust spend is a K=13 circuit, served from the artifact directory the host
    // cached. `NoCircuits` would refuse, which is the correct behaviour for the sponsored path.
    let resolver = crate::wallet::DirResolver {
        dir: std::path::PathBuf::from(extras.artifact_dir),
    };
    let params = crate::wallet::DirParams {
        dir: std::path::PathBuf::from(extras.params_dir),
    };
    let provider = LocalProvingProvider {
        rng: OsRng,
        params: &params,
        resolver: &resolver,
    };
    let proven = block_on(tx.prove(provider, &INITIAL_COST_MODEL))
        .map_err(|e| format!("prove the transfer's dust spend: {e:?}"))?;

    // ⚠️ **Read the identifiers here, before the seal.** They are what a send is matched by on chain,
    // and `proven_tx_identifiers` cannot recover them afterwards: it deserializes a `ProvenTx`, whose
    // header is `embedded-fr`, while a sealed transaction is `pedersen-schnorr`. So every self-funded
    // send came back with none and the pending-send store refused the row — the send landed and then
    // appeared nowhere. Sealing adds a binding signature, not inputs, so these are the identifiers of
    // the transaction that ships.
    let mut identifiers = Vec::new();
    for ident in proven.identifiers() {
        let mut bytes = Vec::new();
        Serializable::serialize(&ident, &mut bytes)
            .map_err(|e| format!("serialize identifier: {e}"))?;
        identifiers.push(format!("\"{}\"", hex_bytes(&bytes)));
    }

    let sealed = proven.seal(OsRng);

    let mut tx_bytes = Vec::new();
    tagged_serialize(&sealed, &mut tx_bytes)
        .map_err(|e| format!("serialize the sealed transfer: {e}"))?;
    let mut state_bytes = Vec::new();
    tagged_serialize(&next_dust_state, &mut state_bytes)
        .map_err(|e| format!("serialize the dust state: {e}"))?;

    Ok(format!(
        "{{\"tx\":\"{}\",\"state\":\"{}\",\"fee\":\"{fee}\",\"identifiers\":[{}]}}",
        hex_bytes(&tx_bytes),
        hex_bytes(&state_bytes),
        identifiers.join(","),
    ))
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// [`build_self_funded_transfer_json`] for the bridges: fixed-width in, JSON out.
#[allow(clippy::too_many_arguments)]
pub fn build_self_funded_transfer_hex(
    night_role_key: &[u8; 32],
    packed_inputs: &[u8],
    recipient_address: &[u8; 32],
    token_type: &[u8; 32],
    value_le: &[u8; 16],
    network_id: &str,
    ttl_secs: u64,
    dust_state: &[u8],
    dust_role_key: &[u8; 32],
    ctime_secs: u64,
    artifact_dir: &str,
    params_dir: &str,
    fee_margin: usize,
    change_chunks: u32,
) -> Result<String, String> {
    let inputs = decode_input_records(packed_inputs)?;
    build_self_funded_transfer_json(
        UnshieldedTransferRequest {
            night_role_key,
            inputs: &inputs,
            recipient_address: *recipient_address,
            token_type: *token_type,
            value: u128::from_le_bytes(*value_le),
            network_id,
            ttl_secs,
            change_chunks,
        },
        SelfFundedExtras {
            dust_state,
            dust_role_key,
            ctime_secs,
            artifact_dir,
            params_dir,
            fee_margin,
        },
    )
}
