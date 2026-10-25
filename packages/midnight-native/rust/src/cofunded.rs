//! Several wallets funding **one** payment — the shape Cardano's co-funded send has
//! (`docs/MIDNIGHT_COFUNDING_PLAN.md`, shape C).
//!
//! ⚠️ **This is not `Transaction::merge`, and must not be built on it.** Merge composes independent
//! self-balancing transactions at distinct segments; it does not pool funds, because a deficit at
//! segment N is only cancellable from segment N's own intent (`crate::balance`). Pooling is one
//! intent, one segment, several owners — which is this module.
//!
//! ## The protocol, and why it is shaped this way
//!
//! `UnshieldedOffer::well_formed` requires `inputs.len() == signatures.len()` with signature *i*
//! verifying against `inputs[i].owner` over `data_to_sign(segment)` of the erased intent. Inputs sort
//! by value and owner. Those two facts force the order:
//!
//! 1. [`build_cofunded_intent`] — the composer gathers every contributor's inputs, builds the payment
//!    and each contributor's change, and **finalises** the intent. Nothing is signed yet.
//! 2. [`sign_cofunded_share`] — each contributor signs, over that finalised intent, **only the inputs
//!    it owns**. It never sees another party's key and cannot sign for them.
//! 3. [`assemble_cofunded_tx`] — the composer places the signatures at their inputs' indices and
//!    proves.
//!
//! ⚠️ **A signature in the wrong slot fails verification rather than being rejected as malformed**, so
//! step 3 indexes rather than appends. `sign_cofunded_share` returns the index with each signature for
//! exactly that reason.
//!
//! ⚠️ **Any change to the intent after step 1 voids every signature already gathered** — the payload is
//! the whole erased intent. That is why the fee is not added here: a DUST action attached later would
//! silently invalidate the round. Fees stay the sponsor's segment, as they are for a single-party
//! transfer.

use midnight_base_crypto::signatures::{Signature, SigningKey, VerifyingKey};
use midnight_base_crypto::time::Timestamp;
use midnight_coin_structure::coin::{UnshieldedTokenType, UserAddress};
use midnight_ledger::structure::{
    Intent, IntentHash, ProofPreimageMarker, Transaction, UnshieldedOffer, UtxoOutput, UtxoSpend,
};
use midnight_onchain_runtime::cost_model::INITIAL_COST_MODEL;
use midnight_serialize::{tagged_deserialize, tagged_serialize, Deserializable};
use midnight_storage::arena::Sp;
use midnight_storage::storage::HashMap as StorageHashMap;
use midnight_transient_crypto::commitment::PedersenRandomness;
use rand::rngs::OsRng;
use std::ops::Deref;

use crate::state_read::DB;
use crate::unshielded::UnshieldedInput;

/// The segment a co-funded transfer lives in. Same as a single-party transfer: segment 0 is the
/// guaranteed segment and an intent placed there is rejected (`IntentAtGuaranteedSegmentId`).
const COFUND_SEGMENT: u16 = 1;

type UnprovenIntent = Intent<Signature, ProofPreimageMarker, PedersenRandomness, DB>;
type UnprovenTx = Transaction<Signature, ProofPreimageMarker, PedersenRandomness, DB>;

/// What one wallet puts into a co-funded payment.
#[derive(Debug, Clone)]
pub struct CoFundContribution<'a> {
    /// The contributor's Night **verifying** key — 32 bytes, BIP-340 x-only, as `signData` reports it.
    ///
    /// ⚠️ Public, and the composer needs it before anyone signs: `UtxoSpend.owner` is the full
    /// verifying key, while an indexer only reports its hash (the address). A contributor publishes
    /// this; it is not derivable from the address.
    pub owner: [u8; 32],
    pub inputs: &'a [UnshieldedInput],
    /// How much of the payment this wallet covers. Its change is `sum(inputs) - contributes`.
    pub contributes: u128,
}

/// Everything the composer needs to finalise a co-funded transfer.
#[derive(Debug, Clone)]
pub struct CoFundedTransferRequest<'a> {
    pub contributions: &'a [CoFundContribution<'a>],
    /// The recipient's `UserAddress` payload — the 32 bytes inside an `mn_addr…` address.
    pub recipient_address: [u8; 32],
    pub token_type: [u8; 32],
    pub network_id: &'a str,
    /// Absolute expiry, unix seconds. Every contributor signs over this, so it is fixed at step 1.
    pub ttl_secs: u64,
}

/// One contributor's signature, and which input it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoFundShare {
    /// The input's index in the **finalised, sorted** offer.
    pub index: u32,
    /// The signature, serialized as `Signature` (64 bytes, r || s).
    pub signature: Vec<u8>,
}

fn verifying_key(bytes: &[u8; 32]) -> Result<VerifyingKey, String> {
    Deserializable::deserialize(&mut &bytes[..], 0)
        .map_err(|_| "malformed owner verifying key".to_string())
}

/// **Step 1 — the composer.** Gather every contribution into one finalised, unsigned intent.
///
/// Returns the tagged bytes of the intent, which is what each contributor signs over. Value is
/// conserved per token type: `sum(all inputs) == payment + sum(each contributor's change)`, because an
/// unshielded offer has no fee to absorb a difference.
pub fn build_cofunded_intent(request: &CoFundedTransferRequest<'_>) -> Result<Vec<u8>, String> {
    if request.contributions.is_empty() {
        return Err("a co-funded transfer needs at least one contributor".into());
    }
    let token = UnshieldedTokenType(midnight_base_crypto::hash::HashOutput(request.token_type));

    let mut inputs: Vec<UtxoSpend> = Vec::new();
    let mut outputs: Vec<UtxoOutput> = Vec::new();
    let mut payment: u128 = 0;

    for contribution in request.contributions {
        if contribution.inputs.is_empty() {
            return Err("a contributor with no inputs cannot fund anything".into());
        }
        let owner = verifying_key(&contribution.owner)?;
        let mut held: u128 = 0;
        for input in contribution.inputs {
            if input.token_type != request.token_type {
                return Err("every input must be the token the transfer moves".into());
            }
            held = held
                .checked_add(input.value)
                .ok_or_else(|| "a contributor's inputs overflow".to_string())?;
            inputs.push(UtxoSpend {
                value: input.value,
                owner: owner.clone(),
                type_: token,
                intent_hash: IntentHash(midnight_base_crypto::hash::HashOutput(input.intent_hash)),
                output_no: input.output_no,
            });
        }
        // Inputs are spent whole, so anything beyond what this wallet pledged comes back to it. Its
        // own address, never the composer's: a co-funder's change is not the composer's to keep.
        let change = held.checked_sub(contribution.contributes).ok_or_else(|| {
            format!(
                "a contributor holds {held} but pledged {}",
                contribution.contributes
            )
        })?;
        if change > 0 {
            outputs.push(UtxoOutput {
                value: change,
                owner: UserAddress::from(owner),
                type_: token,
            });
        }
        payment = payment
            .checked_add(contribution.contributes)
            .ok_or_else(|| "the pledged amounts overflow".to_string())?;
    }

    if payment == 0 {
        return Err("the contributors pledged nothing between them".into());
    }
    outputs.push(UtxoOutput {
        value: payment,
        owner: UserAddress(midnight_base_crypto::hash::HashOutput(
            request.recipient_address,
        )),
        type_: token,
    });

    // ⚠️ `well_formed` rejects unsorted inputs and outputs, and the node runs that check. Sorting here
    // is also what fixes every signature's index, so it must happen before step 2.
    inputs.sort();
    if inputs.windows(2).any(|w| w[0] == w[1]) {
        return Err("the same output was offered twice as an input".into());
    }
    outputs.sort();

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
        Timestamp::from_secs(request.ttl_secs),
    );

    let mut bytes = Vec::new();
    tagged_serialize(&intent, &mut bytes)
        .map_err(|e| format!("serialize co-funded intent: {e}"))?;
    Ok(bytes)
}

fn read_intent(bytes: &[u8]) -> Result<UnprovenIntent, String> {
    tagged_deserialize(&mut &bytes[..]).map_err(|e| format!("read co-funded intent: {e}"))
}

fn offer_of(intent: &UnprovenIntent) -> Result<UnshieldedOffer<Signature, DB>, String> {
    intent
        .fallible_unshielded_offer
        .as_ref()
        .map(|o| o.deref().clone())
        .ok_or_else(|| "this intent carries no unshielded offer".to_string())
}

/// **Step 2 — a contributor.** Sign the inputs this key owns, and only those.
///
/// The payload is `data_to_sign(segment)` over the **erased** intent, so it is indifferent to proofs
/// and to signatures already gathered — which is what lets contributors sign independently and in any
/// order, as long as the intent itself is final.
///
/// Answers an empty list rather than an error when the key owns nothing here: "this wallet is not a
/// contributor" is a fact the caller can act on, and a co-signer that mistakenly asks should be told
/// so rather than handed a failure it cannot distinguish from a broken intent.
pub fn sign_cofunded_share(
    intent_bytes: &[u8],
    night_role_key: &[u8; 32],
) -> Result<Vec<CoFundShare>, String> {
    let signing_key = SigningKey::from_bytes(night_role_key)
        .map_err(|_| "malformed night role key".to_string())?;
    let owner = signing_key.verifying_key();
    let intent = read_intent(intent_bytes)?;
    let offer = offer_of(&intent)?;

    let payload = intent
        .erase_proofs()
        .erase_signatures()
        .data_to_sign(COFUND_SEGMENT);

    let mut shares = Vec::new();
    for (index, input) in Vec::from(&offer.inputs).iter().enumerate() {
        if input.owner != owner {
            continue;
        }
        let signature: Signature = signing_key.sign(&mut OsRng, &payload);
        let mut bytes = Vec::new();
        midnight_serialize::Serializable::serialize(&signature, &mut bytes)
            .map_err(|e| format!("serialize share signature: {e}"))?;
        shares.push(CoFundShare {
            index: index as u32,
            signature: bytes,
        });
    }
    Ok(shares)
}

/// **Step 3 — the composer.** Place every gathered signature at its input's index and prove.
///
/// Returns the tagged bytes of a proven **unbound** transaction — the same thing a single-party
/// transfer produces, so it submits through the existing sponsor path unchanged.
///
/// ⚠️ Refuses a round that is not complete. One signature short is a transaction the node rejects, and
/// finding that out at submission tells nobody which contributor never signed.
pub fn assemble_cofunded_tx(
    intent_bytes: &[u8],
    shares: &[CoFundShare],
    network_id: &str,
) -> Result<Vec<u8>, String> {
    let intent = read_intent(intent_bytes)?;
    let offer = offer_of(&intent)?;
    let inputs = Vec::from(&offer.inputs);

    let mut slots: Vec<Option<Signature>> = vec![None; inputs.len()];
    for share in shares {
        let index = share.index as usize;
        let slot = slots.get_mut(index).ok_or_else(|| {
            format!(
                "a share names input {index}, but the offer has {}",
                inputs.len()
            )
        })?;
        if slot.is_some() {
            return Err(format!("two shares were given for input {index}"));
        }
        let signature: Signature = Deserializable::deserialize(&mut &share.signature[..], 0)
            .map_err(|_| format!("malformed signature for input {index}"))?;
        *slot = Some(signature);
    }
    let missing: Vec<usize> = slots
        .iter()
        .enumerate()
        .filter(|(_, s)| s.is_none())
        .map(|(i, _)| i)
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "no signature for input(s) {missing:?} — the round is not complete"
        ));
    }
    let signatures: Vec<Signature> = slots
        .into_iter()
        .map(|s| s.expect("checked above"))
        .collect();

    let signed_offer = UnshieldedOffer::<Signature, DB> {
        inputs: offer.inputs.clone(),
        outputs: offer.outputs.clone(),
        signatures: signatures.into(),
    };
    // ⚠️ Verified here rather than at the node: a signature in the wrong slot fails verification, and
    // that is a mistake in the *composer*, which is the one place that can still fix it.
    let erased = intent.erase_proofs().erase_signatures();
    signed_offer
        .clone()
        .well_formed(COFUND_SEGMENT, &erased)
        .map_err(|e| format!("the assembled offer is not well formed: {e:?}"))?()
    .map_err(|e| format!("a contributor's signature does not verify: {e:?}"))?;

    let mut assembled = intent.clone();
    assembled.fallible_unshielded_offer = Some(Sp::new(signed_offer));

    let intents =
        StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(COFUND_SEGMENT, assembled);
    let tx = UnprovenTx::from_intents(network_id.to_string(), intents);
    let proven =
        futures::executor::block_on(tx.prove(crate::unshielded::NoCircuits, &INITIAL_COST_MODEL))
            .map_err(|e| format!("prove co-funded transaction: {e:?}"))?;

    let mut bytes = Vec::new();
    tagged_serialize(&proven, &mut bytes)
        .map_err(|e| format!("serialize co-funded transaction: {e}"))?;
    Ok(bytes)
}

// ── The bridge wire format ──────────────────────────────────────────────────────────────────────
//
// Byte arrays in, hex out, matching every other builder on this rail. Fixed-width records for the
// same reason `decode_input_records` uses them: this crate carries no parser, and a divisibility
// check catches truncation where a variable encoding would read a short record as a valid one.

/// `owner(32) ‖ contributes(16, u128 LE) ‖ inputCount(4, u32 LE)`, followed by `inputCount` input
/// records of [`crate::unshielded::INPUT_RECORD_LEN`] bytes each.
///
/// Must equal `CONTRIBUTION_HEADER_LEN` in `src/cofunded-wire.ts`, which writes them.
pub const CONTRIBUTION_HEADER_LEN: usize = 52;

/// `index(4, u32 LE) ‖ signature(64)`. Must equal `SHARE_RECORD_LEN` in `src/cofunded-wire.ts`.
pub const SHARE_RECORD_LEN: usize = 68;

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

struct OwnedContribution {
    owner: [u8; 32],
    contributes: u128,
    inputs: Vec<UnshieldedInput>,
}

/// Decode packed contributions. A record that runs past the end is an error, never a short read: a
/// dropped contributor is a payment funded with less than the composer gathered, which fails at the
/// node with nothing naming the cause.
fn decode_contributions(packed: &[u8]) -> Result<Vec<OwnedContribution>, String> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < packed.len() {
        if packed.len() - at < CONTRIBUTION_HEADER_LEN {
            return Err(format!("a contribution header is cut short at byte {at}"));
        }
        let owner: [u8; 32] = packed[at..at + 32].try_into().expect("32 bytes");
        let contributes =
            u128::from_le_bytes(packed[at + 32..at + 48].try_into().expect("16 bytes"));
        let count =
            u32::from_le_bytes(packed[at + 48..at + 52].try_into().expect("4 bytes")) as usize;
        at += CONTRIBUTION_HEADER_LEN;

        let span = count
            .checked_mul(crate::unshielded::INPUT_RECORD_LEN)
            .ok_or_else(|| "a contribution claims more inputs than could exist".to_string())?;
        if packed.len() - at < span {
            return Err(format!(
                "a contribution claims {count} inputs but the buffer ends first"
            ));
        }
        let inputs = crate::unshielded::decode_input_records(&packed[at..at + span])?;
        at += span;
        out.push(OwnedContribution {
            owner,
            contributes,
            inputs,
        });
    }
    Ok(out)
}

/// [`build_cofunded_intent`] for the bridges.
pub fn build_cofunded_intent_hex(
    packed_contributions: &[u8],
    recipient_address: &[u8; 32],
    token_type: &[u8; 32],
    network_id: &str,
    ttl_secs: u64,
) -> Result<String, String> {
    let owned = decode_contributions(packed_contributions)?;
    let contributions: Vec<CoFundContribution> = owned
        .iter()
        .map(|c| CoFundContribution {
            owner: c.owner,
            inputs: &c.inputs,
            contributes: c.contributes,
        })
        .collect();
    let bytes = build_cofunded_intent(&CoFundedTransferRequest {
        contributions: &contributions,
        recipient_address: *recipient_address,
        token_type: *token_type,
        network_id,
        ttl_secs,
    })?;
    Ok(to_hex(&bytes))
}

/// [`sign_cofunded_share`] for the bridges, answering packed share records as hex.
///
/// An empty answer is a real one — this wallet owns none of the inputs — and the caller has to be able
/// to tell that apart from a failure, which is why it is `""` and not an error.
pub fn sign_cofunded_share_hex(
    intent_bytes: &[u8],
    night_role_key: &[u8; 32],
) -> Result<String, String> {
    let shares = sign_cofunded_share(intent_bytes, night_role_key)?;
    let mut packed = Vec::with_capacity(shares.len() * SHARE_RECORD_LEN);
    for share in &shares {
        if share.signature.len() != SHARE_RECORD_LEN - 4 {
            return Err(format!(
                "a signature is {} bytes, expected {}",
                share.signature.len(),
                SHARE_RECORD_LEN - 4
            ));
        }
        packed.extend_from_slice(&share.index.to_le_bytes());
        packed.extend_from_slice(&share.signature);
    }
    Ok(to_hex(&packed))
}

/// [`assemble_cofunded_tx`] for the bridges.
pub fn assemble_cofunded_tx_hex(
    intent_bytes: &[u8],
    packed_shares: &[u8],
    network_id: &str,
) -> Result<String, String> {
    if packed_shares.len() % SHARE_RECORD_LEN != 0 {
        return Err(format!(
            "packed shares are {} bytes, not a whole number of {SHARE_RECORD_LEN}-byte records",
            packed_shares.len()
        ));
    }
    let shares: Vec<CoFundShare> = packed_shares
        .chunks_exact(SHARE_RECORD_LEN)
        .map(|r| CoFundShare {
            index: u32::from_le_bytes(r[0..4].try_into().expect("4 bytes")),
            signature: r[4..SHARE_RECORD_LEN].to_vec(),
        })
        .collect();
    let tx = assemble_cofunded_tx(intent_bytes, &shares, network_id)?;
    Ok(to_hex(&tx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bip32::{DerivationPath, XPrv};
    use bip39::Mnemonic;

    const NIGHT: [u8; 32] = [0u8; 32];

    /// Two unrelated wallets, derived the way the app derives them.
    fn role_key(account: u32) -> [u8; 32] {
        let seed = Mnemonic::parse("test test test test test test test test test test test junk")
            .unwrap()
            .to_seed("");
        let path: DerivationPath = format!("m/44'/2400'/{account}'/0/0").parse().unwrap();
        XPrv::derive_from_path(&seed, &path)
            .unwrap()
            .private_key()
            .to_bytes()
            .into()
    }

    fn owner_of(key: &[u8; 32]) -> [u8; 32] {
        let vk = SigningKey::from_bytes(key).unwrap().verifying_key();
        let mut bytes = Vec::new();
        midnight_serialize::Serializable::serialize(&vk, &mut bytes).unwrap();
        bytes.try_into().expect("a verifying key is 32 bytes")
    }

    fn input(value: u128, output_no: u32) -> UnshieldedInput {
        UnshieldedInput {
            value,
            token_type: NIGHT,
            intent_hash: [output_no as u8 + 1; 32],
            output_no,
        }
    }

    /// The whole protocol: two wallets pledge toward one payment, each signs only its own inputs, and
    /// the composer assembles them into a transaction the node would accept.
    #[test]
    fn two_wallets_fund_one_payment_end_to_end() {
        let (key_a, key_b) = (role_key(0), role_key(1));
        let a_inputs = [input(3_000_000, 0)];
        let b_inputs = [input(5_000_000, 1)];
        let contributions = [
            CoFundContribution {
                owner: owner_of(&key_a),
                inputs: &a_inputs,
                contributes: 2_000_000,
            },
            CoFundContribution {
                owner: owner_of(&key_b),
                inputs: &b_inputs,
                contributes: 4_000_000,
            },
        ];
        let request = CoFundedTransferRequest {
            contributions: &contributions,
            recipient_address: [9u8; 32],
            token_type: NIGHT,
            network_id: "preprod",
            ttl_secs: 1_800_000_000,
        };

        let intent_bytes =
            build_cofunded_intent(&request).expect("the composer finalises the intent");

        // Each contributor signs independently, seeing only its own key.
        let share_a = sign_cofunded_share(&intent_bytes, &key_a).expect("a signs");
        let share_b = sign_cofunded_share(&intent_bytes, &key_b).expect("b signs");
        assert_eq!(share_a.len(), 1, "a owns one input");
        assert_eq!(share_b.len(), 1, "b owns one input");
        assert_ne!(
            share_a[0].index, share_b[0].index,
            "and they are different inputs"
        );

        let mut shares = share_a;
        shares.extend(share_b);
        let tx = assemble_cofunded_tx(&intent_bytes, &shares, "preprod")
            .expect("the composer assembles");
        assert!(!tx.is_empty(), "a proven, unbound transaction");
    }

    /// ⚠️ The failure this protocol is most likely to produce, and it must be loud: one contributor
    /// never signed. Caught by the composer, which can still chase them.
    #[test]
    fn an_incomplete_round_is_refused_by_name() {
        let (key_a, key_b) = (role_key(0), role_key(1));
        let a_inputs = [input(3_000_000, 0)];
        let b_inputs = [input(5_000_000, 1)];
        let contributions = [
            CoFundContribution {
                owner: owner_of(&key_a),
                inputs: &a_inputs,
                contributes: 2_000_000,
            },
            CoFundContribution {
                owner: owner_of(&key_b),
                inputs: &b_inputs,
                contributes: 4_000_000,
            },
        ];
        let request = CoFundedTransferRequest {
            contributions: &contributions,
            recipient_address: [9u8; 32],
            token_type: NIGHT,
            network_id: "preprod",
            ttl_secs: 1_800_000_000,
        };
        let intent_bytes = build_cofunded_intent(&request).unwrap();
        let only_a = sign_cofunded_share(&intent_bytes, &key_a).unwrap();

        let err = assemble_cofunded_tx(&intent_bytes, &only_a, "preprod")
            .expect_err("one short must refuse");
        assert!(
            err.contains("not complete"),
            "the error should say the round is incomplete, got: {err}"
        );
    }

    /// ⚠️ **The quiet failure this design has to catch.** A signature is valid over the payload but
    /// sits at another input's index — so it verifies as a signature and fails as an *offer*, at the
    /// node, with nothing naming the composer's mistake. Caught here instead, where it can be fixed.
    #[test]
    fn a_signature_in_the_wrong_slot_is_refused_by_the_composer() {
        let (key_a, key_b) = (role_key(0), role_key(1));
        let a_inputs = [input(3_000_000, 0)];
        let b_inputs = [input(5_000_000, 1)];
        let contributions = [
            CoFundContribution {
                owner: owner_of(&key_a),
                inputs: &a_inputs,
                contributes: 2_000_000,
            },
            CoFundContribution {
                owner: owner_of(&key_b),
                inputs: &b_inputs,
                contributes: 4_000_000,
            },
        ];
        let request = CoFundedTransferRequest {
            contributions: &contributions,
            recipient_address: [9u8; 32],
            token_type: NIGHT,
            network_id: "preprod",
            ttl_secs: 1_800_000_000,
        };
        let intent_bytes = build_cofunded_intent(&request).unwrap();
        let a = sign_cofunded_share(&intent_bytes, &key_a).unwrap();
        let b = sign_cofunded_share(&intent_bytes, &key_b).unwrap();

        // Both signatures are real; they are simply swapped onto each other's inputs.
        let swapped = vec![
            CoFundShare {
                index: b[0].index,
                signature: a[0].signature.clone(),
            },
            CoFundShare {
                index: a[0].index,
                signature: b[0].signature.clone(),
            },
        ];
        let err = assemble_cofunded_tx(&intent_bytes, &swapped, "preprod")
            .expect_err("swapped slots must refuse");
        assert!(
            err.contains("verify"),
            "the error should say a signature does not verify, got: {err}"
        );
    }

    /// A wallet that is not a contributor is told so, rather than handed an error it cannot tell apart
    /// from a broken intent.
    #[test]
    fn a_wallet_that_owns_nothing_here_signs_nothing() {
        let key_a = role_key(0);
        let a_inputs = [input(3_000_000, 0)];
        let contributions = [CoFundContribution {
            owner: owner_of(&key_a),
            inputs: &a_inputs,
            contributes: 1_000_000,
        }];
        let request = CoFundedTransferRequest {
            contributions: &contributions,
            recipient_address: [9u8; 32],
            token_type: NIGHT,
            network_id: "preprod",
            ttl_secs: 1_800_000_000,
        };
        let intent_bytes = build_cofunded_intent(&request).unwrap();
        let stranger =
            sign_cofunded_share(&intent_bytes, &role_key(7)).expect("asking is not an error");
        assert!(stranger.is_empty(), "a stranger signs nothing");
    }

    /// Value is conserved: every input is spent whole, so the payment plus each wallet's change is the
    /// whole of what went in. An unshielded offer has no fee to absorb a difference.
    #[test]
    fn every_wallet_gets_its_own_change_back() {
        let (key_a, key_b) = (role_key(0), role_key(1));
        let a_inputs = [input(3_000_000, 0)];
        let b_inputs = [input(5_000_000, 1)];
        let contributions = [
            CoFundContribution {
                owner: owner_of(&key_a),
                inputs: &a_inputs,
                contributes: 2_000_000,
            },
            CoFundContribution {
                owner: owner_of(&key_b),
                inputs: &b_inputs,
                contributes: 4_000_000,
            },
        ];
        let request = CoFundedTransferRequest {
            contributions: &contributions,
            recipient_address: [9u8; 32],
            token_type: NIGHT,
            network_id: "preprod",
            ttl_secs: 1_800_000_000,
        };
        let intent = read_intent(&build_cofunded_intent(&request).unwrap()).unwrap();
        let offer = offer_of(&intent).unwrap();
        let outputs = Vec::from(&offer.outputs);
        let total: u128 = outputs.iter().map(|o| o.value).sum();
        assert_eq!(
            total, 8_000_000,
            "the whole of both wallets' inputs is accounted for"
        );
        assert!(
            outputs.iter().any(|o| o.value == 6_000_000),
            "the payment is what they pledged between them"
        );
        assert!(
            outputs.iter().any(|o| o.value == 1_000_000),
            "a keeps its remainder"
        );
        assert!(
            outputs.iter().any(|o| o.value == 1_000_000),
            "b keeps its remainder"
        );
    }

    /// The packed wire format, round-tripped through the three bridge entry points — the path the
    /// JNI and C ABIs actually take, which the struct-level tests above do not exercise.
    #[test]
    fn the_packed_wire_format_round_trips() {
        let (key_a, key_b) = (role_key(0), role_key(1));
        let pack_contribution = |owner: [u8; 32], contributes: u128, inputs: &[UnshieldedInput]| {
            let mut out = Vec::new();
            out.extend_from_slice(&owner);
            out.extend_from_slice(&contributes.to_le_bytes());
            out.extend_from_slice(&(inputs.len() as u32).to_le_bytes());
            for i in inputs {
                out.extend_from_slice(&i.value.to_le_bytes());
                out.extend_from_slice(&i.token_type);
                out.extend_from_slice(&i.intent_hash);
                out.extend_from_slice(&i.output_no.to_le_bytes());
            }
            out
        };
        let mut packed = pack_contribution(owner_of(&key_a), 2_000_000, &[input(3_000_000, 0)]);
        packed.extend(pack_contribution(
            owner_of(&key_b),
            4_000_000,
            &[input(5_000_000, 1)],
        ));

        let intent_hex =
            build_cofunded_intent_hex(&packed, &[9u8; 32], &NIGHT, "preprod", 1_800_000_000)
                .expect("builds");
        let intent_bytes: Vec<u8> = (0..intent_hex.len() / 2)
            .map(|i| u8::from_str_radix(&intent_hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect();

        let unhex = |h: &str| -> Vec<u8> {
            (0..h.len() / 2)
                .map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap())
                .collect()
        };
        let a = unhex(&sign_cofunded_share_hex(&intent_bytes, &key_a).expect("a signs"));
        let b = unhex(&sign_cofunded_share_hex(&intent_bytes, &key_b).expect("b signs"));
        assert_eq!(a.len(), SHARE_RECORD_LEN, "one share record each");
        assert_eq!(b.len(), SHARE_RECORD_LEN);

        let mut shares = a;
        shares.extend(b);
        let tx = assemble_cofunded_tx_hex(&intent_bytes, &shares, "preprod").expect("assembles");
        assert!(!tx.is_empty());
    }

    /// A truncated contribution is refused rather than read as a shorter one.
    #[test]
    fn a_cut_short_contribution_is_refused() {
        let mut packed = Vec::new();
        packed.extend_from_slice(&owner_of(&role_key(0)));
        packed.extend_from_slice(&2_000_000u128.to_le_bytes());
        packed.extend_from_slice(&1u32.to_le_bytes());
        // …and then no input record at all, though one was claimed.
        let err = build_cofunded_intent_hex(&packed, &[9u8; 32], &NIGHT, "preprod", 1_800_000_000)
            .expect_err("a claimed input that is not there must refuse");
        assert!(err.contains("buffer ends first"), "got: {err}");
    }

    /// A wallet cannot pledge more than it brought.
    #[test]
    fn a_contributor_cannot_pledge_more_than_it_holds() {
        let key_a = role_key(0);
        let a_inputs = [input(1_000_000, 0)];
        let contributions = [CoFundContribution {
            owner: owner_of(&key_a),
            inputs: &a_inputs,
            contributes: 2_000_000,
        }];
        let request = CoFundedTransferRequest {
            contributions: &contributions,
            recipient_address: [9u8; 32],
            token_type: NIGHT,
            network_id: "preprod",
            ttl_secs: 1_800_000_000,
        };
        let err = build_cofunded_intent(&request).expect_err("over-pledging must refuse");
        assert!(
            err.contains("pledged"),
            "the error should name the pledge, got: {err}"
        );
    }
}
