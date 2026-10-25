//! Funding a transaction somebody else composed — the connector's `balanceUnsealedTransaction`.
//!
//! A dApp hands over a proven, signature-enabled, **pre-binding** transaction whose intent spends
//! more than it takes in. The ledger states the shortfall itself: `Transaction::balance(None)`
//! returns a `BTreeMap<(TokenType, segment), i128>` in which a **negative** entry is a deficit and a
//! positive one is a legal surplus (`balancing_check` rejects negatives only). So nothing here has to
//! re-derive what is missing — it reads it, covers it from this wallet's own UTXOs, and signs.
//!
//! **Why the deficit must be funded inside the dApp's own intent, not beside it.** Intents are keyed
//! by segment id, and `balance` attributes an intent's `fallible_unshielded_offer` to *that* segment
//! while every `guaranteed_unshielded_offer` lands in segment 0. A deficit at segment 3 is therefore
//! only cancellable by inputs in segment 3's own intent — adding an intent of our own at some other
//! segment would leave the original one exactly as overspent as before.
//!
//! **Why an intent that already carries inputs is refused rather than extended.** `Intent::sign`
//! signs `data_to_sign(segment)` over the whole proof- and signature-erased intent, and
//! `UnshieldedOffer::well_formed` then requires `inputs.len() == signatures.len()` with signature *i*
//! verifying against `inputs[i].owner`. Adding inputs changes the signed payload, so every signature
//! already in that offer is void; and inputs sort into the offer by value/owner, so we cannot even
//! produce the missing signatures — they belong to keys we do not hold. The API's own doc says an
//! unsealed transaction comes "with no signatures", so this refusal is the spec's shape, not a
//! shortcoming. It is stated as a named error because a dApp can act on it.
//!
//! **Why adding inputs does not disturb binding.** `pedersen_check` sums each intent's
//! `binding_commitment` against the *Zswap* offers' value commitments; unshielded inputs and outputs
//! carry no Pedersen commitment and appear nowhere in it. That is what makes this possible at all on
//! a pre-binding transaction, and it is why `binding_randomness` and every `binding_commitment` pass
//! through untouched.
//!
//! Nothing is proven here. The transaction arrives `ProofMarker`-tagged and leaves the same way: we
//! add unshielded value, which has no circuit.

use std::collections::BTreeMap;
use std::ops::Deref;

use midnight_base_crypto::hash::HashOutput;
use midnight_base_crypto::signatures::{Signature, SigningKey};
use midnight_coin_structure::coin::{TokenType, UnshieldedTokenType, UserAddress};
use midnight_ledger::structure::{
    Intent, IntentHash, ProofMarker, StandardTransaction, Transaction, UnshieldedOffer, UtxoOutput,
    UtxoSpend,
};
use midnight_serialize::{tagged_deserialize, tagged_serialize};
use midnight_storage::arena::Sp;
use midnight_transient_crypto::commitment::PedersenRandomness;
use rand::rngs::OsRng;

use crate::state_read::DB;
use crate::unshielded::{decode_input_records, UnshieldedInput};

/// Proven, signature-enabled, pre-binding — the `Transaction<SignatureEnabled, Proof, PreBinding>`
/// the connector API names for `balanceUnsealedTransaction`, and the same marker triple this rail
/// builds and the sponsor balances.
type UnsealedTx = Transaction<Signature, ProofMarker, PedersenRandomness, DB>;
type UnsealedIntent = Intent<Signature, ProofMarker, PedersenRandomness, DB>;

/// One entry of the ledger's own balance map, in the terms a caller can act on.
///
/// `delta` keeps the ledger's sign: negative is owed, positive is a surplus the transaction is
/// allowed to leave behind. Reporting the magnitude alone would erase the distinction, and a caller
/// that cannot tell a surplus from a deficit cannot decide whether it needs us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BalanceEntry {
    /// `unshielded` | `shielded` | `dust`. Only `unshielded` is fundable here.
    pub kind: &'static str,
    /// 64-hex token type, or `null` for DUST, which has no type bytes.
    pub token_type: Option<[u8; 32]>,
    pub segment: u16,
    pub delta: i128,
}

fn kind_of(token: TokenType) -> (&'static str, Option<[u8; 32]>) {
    match token {
        TokenType::Unshielded(UnshieldedTokenType(HashOutput(bytes))) => {
            ("unshielded", Some(bytes))
        }
        TokenType::Shielded(t) => ("shielded", Some(t.0 .0)),
        TokenType::Dust => ("dust", None),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn deserialize_unsealed(tx_bytes: &[u8]) -> Result<UnsealedTx, String> {
    tagged_deserialize(&mut &tx_bytes[..]).map_err(|e| {
        format!("not a proven, signature-enabled, pre-binding transaction (Transaction<SignatureEnabled, Proof, PreBinding>): {e}")
    })
}

/// Every entry of `Transaction::balance(None)`.
///
/// `None` rather than a fee figure because the DUST fee is the sponsor's and lives in its own
/// segment: passing one would subtract a fee this transaction is never going to carry and invent a
/// deficit nobody has to cover.
pub fn balance_entries(tx_bytes: &[u8]) -> Result<Vec<BalanceEntry>, String> {
    let tx = deserialize_unsealed(tx_bytes)?;
    let balance = tx
        .balance(None)
        .map_err(|e| format!("the ledger could not balance this transaction: {e:?}"))?;
    Ok(balance
        .into_iter()
        .map(|((token, segment), delta)| {
            let (kind, token_type) = kind_of(token);
            BalanceEntry {
                kind,
                token_type,
                segment,
                delta,
            }
        })
        .collect())
}

/// The balance map as JSON, for the `txBalance` read op.
pub fn balance_entries_json(tx_bytes: &[u8]) -> Result<String, String> {
    let entries = balance_entries(tx_bytes)?;
    let rows: Vec<String> = entries
        .iter()
        .map(|e| {
            let token = match e.token_type {
                Some(bytes) => format!("\"{}\"", hex(&bytes)),
                None => "null".to_string(),
            };
            format!(
                "{{\"kind\":\"{}\",\"tokenType\":{},\"segment\":{},\"delta\":\"{}\"}}",
                e.kind, token, e.segment, e.delta,
            )
        })
        .collect();
    Ok(format!("[{}]", rows.join(",")))
}

/// One shortfall this wallet is being asked to cover.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Shortfall {
    segment: u16,
    token: [u8; 32],
    /// Magnitude, always positive.
    owed: u128,
}

/// The deficits of a transaction, refusing every kind this wallet cannot fund and naming which.
///
/// Each refusal is a fact a dApp can act on, which is why none of them is a filter: silently
/// skipping a shielded deficit would return a transaction that still fails `balancing_check`, and the
/// dApp would learn that from the node instead of from us.
fn shortfalls(balance: &BTreeMap<(TokenType, u16), i128>) -> Result<Vec<Shortfall>, String> {
    let mut out = Vec::new();
    for (&(token, segment), &delta) in balance.iter() {
        if delta >= 0 {
            continue;
        }
        let owed = delta
            .checked_neg()
            .and_then(|d| u128::try_from(d).ok())
            .ok_or_else(|| {
                format!("a deficit of {delta} is larger than this wallet can express")
            })?;
        match token {
            TokenType::Shielded(t) => {
                return Err(format!(
                    "this transaction is short {owed} of shielded token {} in segment {segment}, and this wallet funds unshielded deficits only",
                    hex(&t.0 .0),
                ))
            }
            TokenType::Dust => {
                return Err(format!(
                    "this transaction is short {owed} DUST in segment {segment}; DUST is the fee token and the sponsor pays it in its own segment, so it cannot be funded here",
                ))
            }
            TokenType::Unshielded(UnshieldedTokenType(HashOutput(bytes))) => {
                if segment == 0 {
                    // Segment 0 is the guaranteed segment: the deficit is in some intent's
                    // *guaranteed* offer, and it is not even knowable which one, since every
                    // guaranteed offer in the transaction reports there. Worse, NIGHT inputs in the
                    // guaranteed slot are charged against the dismissal budget — the ceiling that
                    // caps a transfer at four inputs (see `crate::unshielded`) — so funding one is a
                    // transaction that balances and is then rejected for its fee calculation.
                    return Err(format!(
                        "this transaction is short {owed} of token {} in segment 0, the guaranteed segment; this wallet funds fallible segments only",
                        hex(&bytes),
                    ));
                }
                out.push(Shortfall {
                    segment,
                    token: bytes,
                    owed,
                });
            }
        }
    }
    Ok(out)
}

/// Fund every unshielded deficit of an unsealed transaction from the supplied UTXOs, sign the intents
/// that changed, and return the tagged bytes.
///
/// The shortfall is **recomputed here** rather than taken from the caller: it is the one number that
/// decides whether the result balances, and a host that arrived at it separately could disagree with
/// the ledger in a way only the node would notice.
///
/// `packed_inputs` is the wire format of [`crate::unshielded::INPUT_RECORD_LEN`] — the caller offers
/// candidates and this spends the fewest that cover each shortfall, largest first, so a wallet with
/// many small UTXOs does not build a transaction out of all of them. Unspent candidates are simply
/// not spent; passing more than needed is expected.
pub fn balance_unsealed_transaction(
    tx_bytes: &[u8],
    night_role_key: &[u8; 32],
    packed_inputs: &[u8],
) -> Result<Vec<u8>, String> {
    let tx = deserialize_unsealed(tx_bytes)?;
    let mut stx = match tx {
        Transaction::Standard(stx) => stx,
        // A rewards claim carries no intents and no offers, so there is nothing to balance and
        // nothing to sign. Returning it unchanged would answer a question that was not asked.
        Transaction::ClaimRewards(_) => {
            return Err("a rewards-claim transaction has no intent to balance".into())
        }
    };

    let balance = stx
        .balance(None)
        .map_err(|e| format!("the ledger could not balance this transaction: {e:?}"))?;
    let shortfalls = shortfalls(&balance)?;
    if shortfalls.is_empty() {
        // Not an error: the caller asked for a balanced transaction and this one already is. Handing
        // back the original bytes says so without inventing an input to spend.
        return Ok(tx_bytes.to_vec());
    }

    let signing_key = SigningKey::from_bytes(night_role_key)
        .map_err(|_| "malformed night role key".to_string())?;
    let owner = signing_key.verifying_key();
    let candidates = decode_input_records(packed_inputs)?;

    // Spent across every shortfall, so one UTXO can never be selected twice — the ledger would
    // reject the duplicate, but only after the user had approved it.
    let mut spent: Vec<(HashOutput, u32)> = Vec::new();

    let mut segments: BTreeMap<u16, Vec<Shortfall>> = BTreeMap::new();
    for s in shortfalls {
        segments.entry(s.segment).or_default().push(s);
    }

    for (segment, owed_here) in segments {
        let intent = stx
            .intents
            .get(&segment)
            .map(|sp| sp.deref().clone())
            .ok_or_else(|| {
                format!("the transaction is short in segment {segment} but carries no intent there")
            })?;

        let existing = intent
            .fallible_unshielded_offer
            .as_ref()
            .map(|sp| sp.deref().clone());
        if let Some(offer) = existing.as_ref() {
            if !offer.inputs.is_empty() {
                return Err(format!(
                    "segment {segment}'s intent already spends {} input(s); adding to an offer invalidates the signatures over it, and this wallet cannot re-sign inputs it does not own",
                    offer.inputs.len(),
                ));
            }
            if !offer.signatures.is_empty() {
                return Err(format!(
                    "segment {segment}'s intent already carries {} signature(s), which funding it would invalidate",
                    offer.signatures.len(),
                ));
            }
        }

        let mut new_inputs: Vec<UtxoSpend> = Vec::new();
        let mut change: Vec<UtxoOutput> = Vec::new();
        for shortfall in owed_here {
            let token = UnshieldedTokenType(HashOutput(shortfall.token));
            let mut usable: Vec<&UnshieldedInput> = candidates
                .iter()
                .filter(|i| {
                    i.token_type == shortfall.token
                        && !spent
                            .iter()
                            .any(|(h, n)| *h == HashOutput(i.intent_hash) && *n == i.output_no)
                })
                .collect();
            // Largest first: the fewest inputs that cover the shortfall is also the smallest
            // transaction and the smallest dismissal cost.
            usable.sort_by(|a, b| {
                b.value
                    .cmp(&a.value)
                    .then(a.intent_hash.cmp(&b.intent_hash))
            });

            let mut taken: u128 = 0;
            let mut chosen: Vec<&UnshieldedInput> = Vec::new();
            for input in usable {
                if taken >= shortfall.owed {
                    break;
                }
                taken = taken
                    .checked_add(input.value)
                    .ok_or_else(|| "the selected inputs overflow a u128".to_string())?;
                chosen.push(input);
            }
            if taken < shortfall.owed {
                return Err(format!(
                    "segment {segment} is short {} of token {} and the inputs offered hold {taken}",
                    shortfall.owed,
                    hex(&shortfall.token),
                ));
            }

            for input in chosen {
                spent.push((HashOutput(input.intent_hash), input.output_no));
                new_inputs.push(UtxoSpend {
                    value: input.value,
                    owner: owner.clone(),
                    type_: token,
                    intent_hash: IntentHash(HashOutput(input.intent_hash)),
                    output_no: input.output_no,
                });
            }
            let remainder = taken - shortfall.owed;
            if remainder > 0 {
                change.push(UtxoOutput {
                    value: remainder,
                    owner: UserAddress::from(owner.clone()),
                    type_: token,
                });
            }
        }

        // The dApp's own outputs are preserved exactly: they are what the transaction is *for*, and
        // this only appends what conserves value back to the sender.
        let mut outputs: Vec<UtxoOutput> = existing
            .as_ref()
            .map(|o| Vec::from(&o.outputs))
            .unwrap_or_default();
        outputs.extend(change);

        // `UnshieldedOffer::well_formed` rejects unsorted inputs and unsorted outputs, and the node
        // runs that check — the ordering is part of the format.
        new_inputs.sort();
        outputs.sort();
        if new_inputs.windows(2).any(|w| w[0] == w[1]) {
            return Err("the same output was offered twice as an input".into());
        }

        let funded = UnshieldedOffer::<Signature, DB> {
            inputs: new_inputs.clone().into(),
            outputs: outputs.into(),
            signatures: vec![].into(),
        };
        let intent = UnsealedIntent {
            fallible_unshielded_offer: Some(Sp::new(funded)),
            ..intent
        };

        // One key per input, in the offer's sorted order. Every input we added is ours, so the
        // `spend.owner != sk.verifying_key()` check inside `sign` holds by construction — and it is
        // that check, not this comment, that would catch a drift.
        let keys: Vec<SigningKey> = new_inputs.iter().map(|_| signing_key.clone()).collect();
        let intent = intent
            .sign(&mut OsRng, segment, &[], &keys, &[])
            .map_err(|e| format!("sign the funded intent in segment {segment}: {e:?}"))?;

        // The signatures are verified here rather than trusted. `well_formed` is the node's own
        // check, so a malformed offer becomes a named error on the device instead of a rejection
        // after the user approved it and the sponsor paid for it.
        let erased = intent.erase_proofs().erase_signatures();
        let offer = intent
            .fallible_unshielded_offer
            .as_ref()
            .map(|sp| sp.deref().clone())
            .ok_or_else(|| "the funded intent lost its offer".to_string())?;
        offer
            .well_formed(segment, &erased)
            .map_err(|e| format!("the funded offer in segment {segment} is malformed: {e:?}"))?(
        )
        .map_err(|e| {
            format!("the signatures on segment {segment}'s funded offer do not verify: {e:?}")
        })?;

        stx = StandardTransaction {
            intents: stx.intents.insert(segment, intent),
            ..stx
        };
    }

    // The whole point, checked rather than assumed: if any segment is still negative the transaction
    // would be rejected as an overspend, and finding that here names the segment.
    let after = stx
        .balance(None)
        .map_err(|e| format!("the ledger could not balance the funded transaction: {e:?}"))?;
    if let Some((&(token, segment), &delta)) = after.iter().find(|(_, &d)| d < 0) {
        let (kind, bytes) = kind_of(token);
        return Err(format!(
            "the funded transaction is still short {} of {kind} token {} in segment {segment}",
            -delta,
            bytes.map(|b| hex(&b)).unwrap_or_else(|| "dust".into()),
        ));
    }

    let funded: UnsealedTx = Transaction::Standard(stx);
    let mut bytes = Vec::new();
    tagged_serialize(&funded, &mut bytes)
        .map_err(|e| format!("serialize the funded transaction: {e}"))?;
    Ok(bytes)
}

/// Hex in, hex out — the shape the JNI and C bridges carry.
pub fn balance_unsealed_transaction_hex(
    tx_bytes: &[u8],
    night_role_key: &[u8; 32],
    packed_inputs: &[u8],
) -> Result<String, String> {
    balance_unsealed_transaction(tx_bytes, night_role_key, packed_inputs).map(|bytes| hex(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    use bip32::{DerivationPath, XPrv};
    use bip39::Mnemonic;
    use futures::executor::block_on;
    use midnight_base_crypto::time::Timestamp;
    use midnight_ledger::structure::ProofPreimageMarker;
    use midnight_onchain_runtime::cost_model::INITIAL_COST_MODEL;
    use midnight_storage::storage::HashMap as StorageHashMap;

    use crate::unshielded::{NoCircuits, INPUT_RECORD_LEN};

    /// NIGHT: the unshielded native token is 32 zero bytes.
    const NIGHT: [u8; 32] = [0u8; 32];
    /// Any other unshielded token, to prove the selection is per-token rather than per-amount.
    const OTHER: [u8; 32] = [7u8; 32];

    type UnprovenIntent = Intent<Signature, ProofPreimageMarker, PedersenRandomness, DB>;
    type UnprovenTx = Transaction<Signature, ProofPreimageMarker, PedersenRandomness, DB>;

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

    fn pack(inputs: &[UnshieldedInput]) -> Vec<u8> {
        let mut out = Vec::with_capacity(inputs.len() * INPUT_RECORD_LEN);
        for i in inputs {
            out.extend_from_slice(&i.value.to_le_bytes());
            out.extend_from_slice(&i.token_type);
            out.extend_from_slice(&i.intent_hash);
            out.extend_from_slice(&i.output_no.to_le_bytes());
        }
        out
    }

    fn utxo(value: u128, output_no: u32, token: [u8; 32]) -> UnshieldedInput {
        UnshieldedInput {
            value,
            token_type: token,
            intent_hash: [output_no as u8 + 1; 32],
            output_no,
        }
    }

    fn out(value: u128, token: [u8; 32]) -> UtxoOutput {
        UtxoOutput {
            value,
            owner: UserAddress(HashOutput([9u8; 32])),
            type_: UnshieldedTokenType(HashOutput(token)),
        }
    }

    /// The workbench's fixture, in Rust: an intent whose fallible offer pays an output it has no input
    /// to cover, proven only far enough to carry the `Proof` marker. `Transaction::prove` walks
    /// actions, dust actions and coin offers — all empty here — so [`NoCircuits`] is never asked for a
    /// proof, exactly as the mock dApp's own `noProofsExpected` provider is not.
    fn unbalanced(segment: u16, outputs: Vec<UtxoOutput>, inputs: Vec<UtxoSpend>) -> Vec<u8> {
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
        let intents = StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(segment, intent);
        let tx = UnprovenTx::from_intents("preprod".to_string(), intents);
        let proven =
            block_on(tx.prove(NoCircuits, &INITIAL_COST_MODEL)).expect("marker-only prove");
        let mut bytes = Vec::new();
        tagged_serialize(&proven, &mut bytes).expect("serialize");
        bytes
    }

    /// A guaranteed-slot deficit, which is the one place this refuses to fund.
    fn unbalanced_guaranteed(segment: u16, outputs: Vec<UtxoOutput>) -> Vec<u8> {
        let offer = UnshieldedOffer::<Signature, DB> {
            inputs: vec![].into(),
            outputs: outputs.into(),
            signatures: vec![].into(),
        };
        let intent: UnprovenIntent = UnprovenIntent::new(
            &mut OsRng,
            Some(offer),
            None,
            vec![],
            vec![],
            vec![],
            None,
            Timestamp::from_secs(1_800_000_000),
        );
        let intents = StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(segment, intent);
        let tx = UnprovenTx::from_intents("preprod".to_string(), intents);
        let proven =
            block_on(tx.prove(NoCircuits, &INITIAL_COST_MODEL)).expect("marker-only prove");
        let mut bytes = Vec::new();
        tagged_serialize(&proven, &mut bytes).expect("serialize");
        bytes
    }

    fn offer_at(bytes: &[u8], segment: u16) -> UnshieldedOffer<Signature, DB> {
        let tx: UnsealedTx = tagged_deserialize(&mut &bytes[..]).expect("funded tx deserializes");
        let Transaction::Standard(stx) = tx else {
            panic!("expected a standard transaction")
        };
        stx.intents
            .get(&segment)
            .expect("intent at segment")
            .fallible_unshielded_offer
            .as_ref()
            .map(|sp| sp.deref().clone())
            .expect("fallible offer")
    }

    #[test]
    fn the_ledger_reports_the_deficit_and_this_reads_it_back() {
        let tx = unbalanced(1, vec![out(1_000_000, NIGHT)], vec![]);
        let entries = balance_entries(&tx).expect("balance");
        assert_eq!(
            entries,
            vec![BalanceEntry {
                kind: "unshielded",
                token_type: Some(NIGHT),
                segment: 1,
                delta: -1_000_000,
            }],
        );
    }

    #[test]
    fn the_json_shape_carries_the_sign_and_the_token() {
        let tx = unbalanced(1, vec![out(1_000_000, NIGHT)], vec![]);
        assert_eq!(
            balance_entries_json(&tx).expect("json"),
            format!(
                "[{{\"kind\":\"unshielded\",\"tokenType\":\"{}\",\"segment\":1,\"delta\":\"-1000000\"}}]",
                hex(&NIGHT)
            ),
        );
    }

    #[test]
    fn funding_a_deficit_leaves_the_transaction_balanced_and_signed() {
        let key = night_role_key();
        let tx = unbalanced(1, vec![out(1_000_000, NIGHT)], vec![]);
        let inputs = pack(&[utxo(1_500_000, 0, NIGHT)]);

        let funded = balance_unsealed_transaction(&tx, &key, &inputs).expect("funded");

        // No negative entry left anywhere: this is the property the node checks.
        assert!(
            balance_entries(&funded)
                .expect("balance")
                .iter()
                .all(|e| e.delta >= 0),
            "a funded transaction must have no deficit",
        );
        let offer = offer_at(&funded, 1);
        assert_eq!(offer.inputs.len(), 1, "one input covers it");
        // The dApp's output plus our change.
        assert_eq!(
            offer.outputs.len(),
            2,
            "the dApp's output survives and change is added"
        );
        assert_eq!(
            offer.inputs.len(),
            offer.signatures.len(),
            "well_formed requires one signature per input",
        );
        let change: Vec<u128> = Vec::from(&offer.outputs)
            .iter()
            .filter(|o| {
                o.owner == UserAddress::from(SigningKey::from_bytes(&key).unwrap().verifying_key())
            })
            .map(|o| o.value)
            .collect();
        assert_eq!(change, vec![500_000], "the remainder returns to the sender");
    }

    #[test]
    fn the_dapps_own_output_is_preserved_byte_for_byte() {
        let key = night_role_key();
        let recipient = out(1_000_000, NIGHT);
        let tx = unbalanced(1, vec![recipient.clone()], vec![]);
        let funded = balance_unsealed_transaction(&tx, &key, &pack(&[utxo(1_000_000, 0, NIGHT)]))
            .expect("funded");
        let outputs = Vec::from(&offer_at(&funded, 1).outputs);
        assert!(
            outputs.contains(&recipient),
            "the output the dApp asked for must still be there, unchanged",
        );
    }

    #[test]
    fn an_exact_cover_adds_no_change_output() {
        let key = night_role_key();
        let tx = unbalanced(1, vec![out(1_000_000, NIGHT)], vec![]);
        let funded = balance_unsealed_transaction(&tx, &key, &pack(&[utxo(1_000_000, 0, NIGHT)]))
            .expect("funded");
        let offer = offer_at(&funded, 1);
        assert_eq!(
            offer.outputs.len(),
            1,
            "an exact cover leaves nothing to return"
        );
    }

    #[test]
    fn the_fewest_inputs_that_cover_it_are_spent() {
        let key = night_role_key();
        let tx = unbalanced(1, vec![out(1_000_000, NIGHT)], vec![]);
        // Largest first: one 900k plus one 200k covers it; the four 100k UTXOs stay unspent.
        let inputs = pack(&[
            utxo(100_000, 0, NIGHT),
            utxo(100_000, 1, NIGHT),
            utxo(900_000, 2, NIGHT),
            utxo(100_000, 3, NIGHT),
            utxo(200_000, 4, NIGHT),
            utxo(100_000, 5, NIGHT),
        ]);
        let funded = balance_unsealed_transaction(&tx, &key, &inputs).expect("funded");
        assert_eq!(offer_at(&funded, 1).inputs.len(), 2, "two inputs suffice");
    }

    #[test]
    fn two_tokens_short_in_one_segment_are_both_funded() {
        let key = night_role_key();
        let tx = unbalanced(1, vec![out(1_000_000, NIGHT), out(40, OTHER)], vec![]);
        let inputs = pack(&[utxo(1_000_000, 0, NIGHT), utxo(100, 1, OTHER)]);
        let funded = balance_unsealed_transaction(&tx, &key, &inputs).expect("funded");
        assert!(
            balance_entries(&funded)
                .expect("balance")
                .iter()
                .all(|e| e.delta >= 0),
            "both tokens must end up covered",
        );
        let offer = offer_at(&funded, 1);
        assert_eq!(offer.inputs.len(), 2, "one input per token");
        assert_eq!(offer.inputs.len(), offer.signatures.len());
    }

    #[test]
    fn a_balanced_transaction_comes_back_untouched() {
        let key = night_role_key();
        // One input covering its own output: nothing owed.
        let signing = SigningKey::from_bytes(&key).unwrap();
        let spend = UtxoSpend {
            value: 1_000_000,
            owner: signing.verifying_key(),
            type_: UnshieldedTokenType(HashOutput(NIGHT)),
            intent_hash: IntentHash(HashOutput([1u8; 32])),
            output_no: 0,
        };
        let tx = unbalanced(1, vec![out(1_000_000, NIGHT)], vec![spend]);
        let funded = balance_unsealed_transaction(&tx, &key, &pack(&[utxo(5_000_000, 9, NIGHT)]))
            .expect("unchanged");
        assert_eq!(
            funded, tx,
            "nothing owed means nothing added and nothing spent"
        );
    }

    #[test]
    fn an_intent_that_already_spends_is_refused_by_name() {
        let key = night_role_key();
        let signing = SigningKey::from_bytes(&key).unwrap();
        // An input that does not cover the output: a real deficit, but in an offer we cannot extend.
        let spend = UtxoSpend {
            value: 400_000,
            owner: signing.verifying_key(),
            type_: UnshieldedTokenType(HashOutput(NIGHT)),
            intent_hash: IntentHash(HashOutput([1u8; 32])),
            output_no: 0,
        };
        let tx = unbalanced(1, vec![out(1_000_000, NIGHT)], vec![spend]);
        let err = balance_unsealed_transaction(&tx, &key, &pack(&[utxo(1_000_000, 9, NIGHT)]))
            .expect_err("an offer with inputs cannot be extended");
        assert!(
            err.contains("already spends"),
            "the refusal must name the cause: {err}"
        );
        assert!(err.contains("segment 1"), "and the segment: {err}");
    }

    #[test]
    fn a_guaranteed_segment_deficit_is_refused_by_name() {
        let key = night_role_key();
        let tx = unbalanced_guaranteed(1, vec![out(1_000_000, NIGHT)]);
        let err = balance_unsealed_transaction(&tx, &key, &pack(&[utxo(5_000_000, 0, NIGHT)]))
            .expect_err("the guaranteed segment is not fundable here");
        assert!(
            err.contains("segment 0"),
            "the refusal must name the segment: {err}"
        );
        assert!(err.contains("guaranteed"), "and why: {err}");
    }

    #[test]
    fn inputs_that_do_not_cover_the_shortfall_are_refused_with_both_figures() {
        let key = night_role_key();
        let tx = unbalanced(1, vec![out(1_000_000, NIGHT)], vec![]);
        let err = balance_unsealed_transaction(&tx, &key, &pack(&[utxo(400_000, 0, NIGHT)]))
            .expect_err("400k cannot cover 1M");
        assert!(err.contains("1000000"), "the shortfall: {err}");
        assert!(err.contains("400000"), "and what was offered: {err}");
    }

    #[test]
    fn a_token_the_wallet_holds_nothing_of_is_refused() {
        let key = night_role_key();
        let tx = unbalanced(1, vec![out(40, OTHER)], vec![]);
        let err = balance_unsealed_transaction(&tx, &key, &pack(&[utxo(5_000_000, 0, NIGHT)]))
            .expect_err("NIGHT cannot cover another token");
        assert!(
            err.contains(&hex(&OTHER)),
            "the refusal must name the token: {err}"
        );
    }

    #[test]
    fn one_utxo_is_never_spent_twice_across_segments() {
        let key = night_role_key();
        // Two intents, each short 600k, and a single 1.5M UTXO on offer: it can only fund one.
        let offer_a = UnshieldedOffer::<Signature, DB> {
            inputs: vec![].into(),
            outputs: vec![out(600_000, NIGHT)].into(),
            signatures: vec![].into(),
        };
        let offer_b = UnshieldedOffer::<Signature, DB> {
            inputs: vec![].into(),
            outputs: vec![out(600_000, NIGHT)].into(),
            signatures: vec![].into(),
        };
        let mk = |offer: UnshieldedOffer<Signature, DB>| -> UnprovenIntent {
            UnprovenIntent::new(
                &mut OsRng,
                None,
                Some(offer),
                vec![],
                vec![],
                vec![],
                None,
                Timestamp::from_secs(1_800_000_000),
            )
        };
        let intents = StorageHashMap::<u16, UnprovenIntent, DB>::new()
            .insert(1, mk(offer_a))
            .insert(2, mk(offer_b));
        let tx = UnprovenTx::from_intents("preprod".to_string(), intents);
        let proven =
            block_on(tx.prove(NoCircuits, &INITIAL_COST_MODEL)).expect("marker-only prove");
        let mut bytes = Vec::new();
        tagged_serialize(&proven, &mut bytes).expect("serialize");

        let err = balance_unsealed_transaction(&bytes, &key, &pack(&[utxo(1_500_000, 0, NIGHT)]))
            .expect_err("one UTXO cannot fund two segments");
        assert!(
            err.contains("600000"),
            "the second shortfall must be named: {err}"
        );
    }

    #[test]
    fn two_segments_are_both_funded_when_there_are_utxos_for_both() {
        let key = night_role_key();
        let mk = |value: u128| -> UnprovenIntent {
            UnprovenIntent::new(
                &mut OsRng,
                None,
                Some(UnshieldedOffer::<Signature, DB> {
                    inputs: vec![].into(),
                    outputs: vec![out(value, NIGHT)].into(),
                    signatures: vec![].into(),
                }),
                vec![],
                vec![],
                vec![],
                None,
                Timestamp::from_secs(1_800_000_000),
            )
        };
        let intents = StorageHashMap::<u16, UnprovenIntent, DB>::new()
            .insert(1, mk(600_000))
            .insert(2, mk(700_000));
        let tx = UnprovenTx::from_intents("preprod".to_string(), intents);
        let proven =
            block_on(tx.prove(NoCircuits, &INITIAL_COST_MODEL)).expect("marker-only prove");
        let mut bytes = Vec::new();
        tagged_serialize(&proven, &mut bytes).expect("serialize");

        let inputs = pack(&[utxo(1_000_000, 0, NIGHT), utxo(1_000_000, 1, NIGHT)]);
        let funded = balance_unsealed_transaction(&bytes, &key, &inputs).expect("both funded");
        assert!(balance_entries(&funded)
            .expect("balance")
            .iter()
            .all(|e| e.delta >= 0));
        for segment in [1u16, 2u16] {
            let offer = offer_at(&funded, segment);
            assert_eq!(offer.inputs.len(), 1, "segment {segment} spends one input");
            assert_eq!(
                offer.inputs.len(),
                offer.signatures.len(),
                "segment {segment} is signed"
            );
        }
    }

    #[test]
    fn garbage_is_refused_as_the_wrong_marker_triple() {
        let key = night_role_key();
        let err =
            balance_unsealed_transaction(&[0u8; 16], &key, &[]).expect_err("not a transaction");
        assert!(
            err.contains("PreBinding"),
            "the refusal must name what was expected: {err}"
        );
    }

    #[test]
    fn a_sealed_transaction_is_refused_rather_than_misread() {
        // A bound transaction has a different marker triple, so it cannot deserialize here — which is
        // what makes `balanceSealedTransaction` a separate, refused method rather than this one.
        let key = night_role_key();
        let tx = unbalanced(1, vec![out(1_000_000, NIGHT)], vec![]);
        // Truncating is the cheapest way to a valid tag with an invalid body.
        let err =
            balance_unsealed_transaction(&tx[..tx.len() / 2], &key, &[]).expect_err("truncated");
        assert!(err.contains("PreBinding"), "{err}");
    }
}
