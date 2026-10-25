//! What a Midnight transaction **contains**, read from the transaction itself.
//!
//! The review screens build from what their caller said, because until now there was no transaction
//! to read: a `makeTransfer` is approved and *then* built. `docs/MIDNIGHT_REVIEW_FROM_BYTES.md` has
//! the argument for turning that round; this is the device half of it.
//!
//! ⚠️ **Why here and not in TypeScript.** `packages/tx-review/midnight-facts.ts` already reads the
//! same structure from a *deserialized* transaction — but deserializing needs the ledger, and the
//! ledger reaches the device only through this crate (Hermes has no WASM). So the phone reads its
//! facts here and the two readers walk the same shape for two hosts. They agree on vocabulary
//! deliberately: `owner` is a **32-byte `UserAddress`, hex** on both sides, which is what makes a
//! contributor's inputs comparable to a wallet's own address.
//!
//! ⚠️ **An input's owner is a `VerifyingKey` and an output's is a `UserAddress`.** Reporting them as
//! they are would put two vocabularies in one field, and a review comparing an address against a
//! verifying key would attribute every input to a stranger — which for a co-funded transaction means
//! reporting somebody else's contribution as our own spend, or the reverse. `UserAddress::from` is
//! the hash the address carries, so inputs are converted and outputs pass through.
//!
//! ⚠️ **Shielded is a count, never an amount.** A Zswap offer's values and recipients are encrypted;
//! only the wallet's own key can open its own outputs, and that happens host-side (`tryDecrypt`). A
//! reader that totalled a shielded offer would be inventing the figure.
//!
//! Nothing here needs a key or a network call: the transaction says all of it.

use midnight_base_crypto::hash::HashOutput;
use midnight_base_crypto::signatures::Signature;
use midnight_coin_structure::coin::{UnshieldedTokenType, UserAddress};
use midnight_ledger::structure::{
    ContractAction, Intent, ProofMarker, StandardTransaction, Transaction, UnshieldedOffer,
    UtxoOutput, UtxoSpend,
};
use midnight_serialize::tagged_deserialize;
use midnight_storage::arena::Sp;
use midnight_storage::Storable;
use midnight_transient_crypto::commitment::{PedersenRandomness, PureGeneratorPedersen};
use std::ops::Deref;

use crate::state_read::DB;

/// The marker triple `crate::balance` reads and this rail builds: proven, signature-enabled,
/// pre-binding — what a builder hands back, before the sponsor binds it.
type UnsealedTx = Transaction<Signature, ProofMarker, PedersenRandomness, DB>;

/// The same transaction once it has been **bound** (`pedersen-schnorr[v1]`), which is the form every
/// transaction on chain takes.
///
/// ⚠️ Reading this shape is what lets a review screen or an agent answer "what did that transaction
/// do?" about something that has already happened. Without it the reader accepted only transactions
/// that had not been submitted yet, and refused every one fetched back from an indexer.
type SealedTx = Transaction<Signature, ProofMarker, PureGeneratorPedersen, DB>;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A JSON string literal, escaped.
///
/// Hand-written because this crate carries no serializer, and an entry-point name is the one field
/// here that is not hex: it is a byte string from a contract, so it can hold a quote or a control
/// character and an unescaped one would produce JSON the host cannot parse at all.
fn json_str(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// An entry point as text when it is text, and as hex when it is not.
///
/// ⚠️ Not `from_utf8_lossy`: replacement characters would render a name that looks like a name and is
/// not the one on chain. The ledger's own `Debug` for these buffers makes the same choice.
fn entry_point_of(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => json_str(text),
        Err(_) => json_str(&hex(bytes)),
    }
}

fn utxo_json(colour: &[u8; 32], value: u128, owner: &[u8; 32]) -> String {
    format!(
        "{{\"colour\":\"{}\",\"value\":\"{}\",\"owner\":\"{}\"}}",
        hex(colour),
        value,
        hex(owner),
    )
}

fn spend_json(spend: &UtxoSpend) -> String {
    let UnshieldedTokenType(HashOutput(colour)) = spend.type_;
    // The address form, not the verifying key — see the module header.
    let UserAddress(HashOutput(owner)) = UserAddress::from(spend.owner.clone());
    utxo_json(&colour, spend.value, &owner)
}

fn output_json(output: &UtxoOutput) -> String {
    let UnshieldedTokenType(HashOutput(colour)) = output.type_;
    let UserAddress(HashOutput(owner)) = output.owner;
    utxo_json(&colour, output.value, &owner)
}

/// One unshielded offer as `{"inputs":[…],"outputs":[…]}`.
///
/// An absent offer is empty rather than missing: a section a transaction does not use holds no value,
/// and a host reading `null` there would have to decide what that meant.
fn section_json(offer: Option<&Sp<UnshieldedOffer<Signature, DB>, DB>>) -> String {
    let Some(offer) = offer else {
        return "{\"inputs\":[],\"outputs\":[]}".to_string();
    };
    let offer = offer.deref();
    let inputs: Vec<String> = offer.inputs.iter_deref().map(spend_json).collect();
    let outputs: Vec<String> = offer.outputs.iter_deref().map(output_json).collect();
    format!(
        "{{\"inputs\":[{}],\"outputs\":[{}]}}",
        inputs.join(","),
        outputs.join(",")
    )
}

/// ⚠️ Generic over the binding parameter so one reader serves both shapes. The ledger bounds it at
/// `Storable` only, and nothing here reads the binding — an intent's inputs, outputs, calls and
/// deploys are the same whether or not it has been sealed.
fn intent_json<B: Storable<DB>>(
    segment: u16,
    intent: &Intent<Signature, ProofMarker, B, DB>,
) -> String {
    let mut calls: Vec<String> = Vec::new();
    let mut deploys: Vec<String> = Vec::new();
    let mut other_actions = 0usize;
    for action in intent.actions.iter_deref() {
        match action {
            ContractAction::Call(call) => {
                let call = call.deref();
                let ContractAddressBytes(address) = address_of(&call.address);
                calls.push(format!(
                    "{{\"address\":\"{}\",\"entryPoint\":{}}}",
                    hex(&address),
                    entry_point_of(&call.entry_point),
                ));
            }
            ContractAction::Deploy(deploy) => {
                // The address a deploy *will* have, which is a hash of the deploy itself — the same
                // figure an explorer shows, and the only name the contract has before it exists.
                let ContractAddressBytes(address) = address_of(&deploy.deref().address());
                deploys.push(format!("{{\"address\":\"{}\"}}", hex(&address)));
            }
            // Counted, never dropped: a maintenance update changes who may change the contract, and
            // a transaction that looked like it carried no actions would be the wrong thing to show.
            ContractAction::Maintain(_) => other_actions += 1,
        }
    }
    format!(
        "{{\"segment\":{},\"ttlSecs\":{},\"guaranteed\":{},\"fallible\":{},\"calls\":[{}],\"deploys\":[{}],\"otherActions\":{}}}",
        segment,
        intent.ttl.to_secs(),
        section_json(intent.guaranteed_unshielded_offer.as_ref()),
        section_json(intent.fallible_unshielded_offer.as_ref()),
        calls.join(","),
        deploys.join(","),
        other_actions,
    )
}

/// Newtype so the two address shapes cannot be swapped by accident at the call sites above.
struct ContractAddressBytes([u8; 32]);

fn address_of(
    address: &midnight_coin_structure::contract::ContractAddress,
) -> ContractAddressBytes {
    ContractAddressBytes(address.0 .0)
}

fn standard_json<B: Storable<DB>>(
    stx: &StandardTransaction<Signature, ProofMarker, B, DB>,
    bound: bool,
) -> String {
    let mut segments: Vec<u16> = stx.intents.keys().collect();
    // Ascending, because a segment id is not decorative: it is what a deficit can be funded from, and
    // what tells one contributor's intent from another's.
    segments.sort_unstable();
    let intents: Vec<String> = segments
        .iter()
        .filter_map(|segment| {
            stx.intents
                .get(segment)
                .map(|intent| intent_json(*segment, intent.deref()))
        })
        .collect();

    let mut shielded_outputs = 0usize;
    let mut has_shielded = false;
    if let Some(guaranteed) = stx.guaranteed_coins.as_ref() {
        has_shielded = true;
        shielded_outputs += guaranteed.deref().outputs.len();
    }
    for segment in stx.fallible_coins.keys() {
        if let Some(offer) = stx.fallible_coins.get(&segment) {
            has_shielded = true;
            shielded_outputs += offer.outputs.len();
        }
    }

    format!(
        "{{\"understood\":true,\"bound\":{bound},\"networkId\":{},\"intents\":[{}],\"shieldedOutputs\":{},\"hasShielded\":{}}}",
        json_str(&stx.network_id),
        intents.join(","),
        shielded_outputs,
        has_shielded,
    )
}

/// Read a transaction's facts as JSON, for the `txFacts` read op.
///
/// ⚠️ A shape this reader does not describe comes back `understood: false` **with the fields it could
/// read**, never as an error and never as empty facts. A rewards claim is the live case: it carries no
/// intents, so empty facts would render as "this transaction does nothing" — the one wrong thing to
/// tell someone about to approve it.
///
/// Bytes that are not a transaction at all *are* an error: "could not be read" and "does nothing" are
/// different answers and only one of them belongs on a review screen.
pub fn tx_facts_json(tx_bytes: &[u8]) -> Result<String, String> {
    // ⚠️ **Try pre-binding, then bound — and the order is safe because the tag is enforced.**
    // `tagged_deserialize` checks the header tag before reading anything, so the wrong variant fails
    // cleanly rather than misreading the bytes. That is what makes a fallback acceptable here; the
    // equivalent JS `Transaction.deserialize` takes its markers on trust and, given the wrong triple,
    // misinterprets the bytes into a cryptic "Invalid signature value" instead.
    //
    // Pre-binding first because it is the shape this device builds and reviews. Bound is the shape
    // every transaction on chain has, which is what someone holds when they ask what one did.
    let unsealed_error = match tagged_deserialize::<UnsealedTx>(&mut &tx_bytes[..]) {
        Ok(tx) => return Ok(transaction_json(tx, false)),
        Err(e) => e,
    };
    match tagged_deserialize::<SealedTx>(&mut &tx_bytes[..]) {
        Ok(tx) => Ok(transaction_json(tx, true)),
        // The pre-binding error is the one reported: bytes that are not a transaction at all fail both
        // attempts, and the first names the tag we look for before anything else.
        Err(_) => Err(format!(
            "not a proven, signature-enabled transaction in either binding state (pre-binding or bound): {unsealed_error}"
        )),
    }
}

/// The facts of a transaction in either binding state.
///
/// `bound` is the state the reader actually found it in, not a guess: a bound transaction is finished
/// and goes to the node as-is, while a pre-binding one still needs somebody to bind it. A caller that
/// has to choose a submission rail cannot tell the two apart from the bytes without deserializing them,
/// and the tag check that decides it happens here already.
fn transaction_json<B: Storable<DB>>(
    tx: Transaction<Signature, ProofMarker, B, DB>,
    bound: bool,
) -> String {
    match tx {
        Transaction::Standard(stx) => standard_json(&stx, bound),
        Transaction::ClaimRewards(claim) => format!(
            "{{\"understood\":false,\"bound\":{bound},\"networkId\":{},\"intents\":[],\"shieldedOutputs\":0,\"hasShielded\":false}}",
            json_str(&claim.network_id),
        ),
    }
}

#[cfg(test)]
mod bound_tests {
    use super::*;

    /// A real preprod transaction, taken from the indexer at block 2,306,724 — the co-funded send two
    /// of this project's wallets made on 2026-08-28. It is **bound** (`pedersen-schnorr[v1]`), the
    /// shape every transaction on chain has and the one this reader used to refuse outright.
    ///
    /// ⚠️ A historical chain transaction cannot rot: its bytes are fixed for ever. That is why this is
    /// a captured fixture rather than one built in the test — the point is to prove the reader accepts
    /// what the chain actually serves, not only what we can construct.
    const BOUND_TX_HEX: &str = include_str!("../fixtures/bound-tx-preprod-2306724.hex");

    fn bound_bytes() -> Vec<u8> {
        let hex = BOUND_TX_HEX.trim();
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("fixture is hex"))
            .collect()
    }

    #[test]
    fn reads_a_bound_transaction_from_chain() {
        let json = tx_facts_json(&bound_bytes()).expect("a bound transaction is readable");
        assert!(
            json.contains("\"networkId\":\"preprod\""),
            "names its network: {json}"
        );
        // The unshielded outputs the indexer reports for this transaction: 3,125,000 and 30,000,000 of
        // change, and the 80,000,000 payment.
        assert!(
            json.contains("80000000"),
            "carries the payment amount: {json}"
        );
        assert!(
            json.contains("30000000"),
            "carries a contributor's change: {json}"
        );
    }

    #[test]
    fn still_refuses_bytes_that_are_not_a_transaction() {
        let error = tx_facts_json(&[0u8, 1, 2, 3]).expect_err("junk is not a transaction");
        assert!(
            error.contains("either binding state"),
            "the refusal says both shapes were tried: {error}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cofunded::{
        assemble_cofunded_tx, build_cofunded_intent, sign_cofunded_share, CoFundContribution,
        CoFundedTransferRequest,
    };
    use crate::unshielded::UnshieldedInput;
    use bip32::{DerivationPath, XPrv};
    use bip39::Mnemonic;
    use midnight_base_crypto::signatures::SigningKey;

    const NIGHT: [u8; 32] = [0u8; 32];
    const RECIPIENT: [u8; 32] = [9u8; 32];
    const TTL: u64 = 1_800_000_000;

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

    /// The address that key owns — the hash of its verifying key, and what an indexer reports.
    fn address_of_key(key: &[u8; 32]) -> String {
        let vk = SigningKey::from_bytes(key).unwrap().verifying_key();
        let UserAddress(HashOutput(bytes)) = UserAddress::from(vk);
        hex(&bytes)
    }

    fn input(value: u128, output_no: u32) -> UnshieldedInput {
        UnshieldedInput {
            value,
            token_type: NIGHT,
            intent_hash: [output_no as u8 + 1; 32],
            output_no,
        }
    }

    /// A co-funded transfer two wallets paid for — the transaction the review has to read correctly.
    fn two_owner_tx() -> Vec<u8> {
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
            recipient_address: RECIPIENT,
            token_type: NIGHT,
            network_id: "preprod",
            ttl_secs: TTL,
        };
        let intent = build_cofunded_intent(&request).expect("the composer finalises");
        let mut shares = sign_cofunded_share(&intent, &key_a).expect("a signs");
        shares.extend(sign_cofunded_share(&intent, &key_b).expect("b signs"));
        assemble_cofunded_tx(&intent, &shares, "preprod").expect("the composer assembles")
    }

    /// ⚠️ **The trap this module exists around.** An input's owner is a `VerifyingKey` and an output's
    /// is a `UserAddress`; reporting them as they are would make every co-funded input look like a
    /// stranger's, so a wallet would read its own contribution as somebody else's money. Both keys'
    /// *addresses* must appear, and neither verifying key may.
    #[test]
    fn an_input_is_attributed_to_its_owner_s_address() {
        let facts = tx_facts_json(&two_owner_tx()).expect("a co-funded transaction reads");
        let (key_a, key_b) = (role_key(0), role_key(1));
        for key in [&key_a, &key_b] {
            assert!(
                facts.contains(&format!("\"owner\":\"{}\"", address_of_key(key))),
                "each contributor's address is named: {facts}",
            );
            assert!(
                !facts.contains(&hex(&owner_of(key))),
                "and no verifying key is reported as an owner",
            );
        }
    }

    /// Every figure a review would put on screen, from the bytes alone.
    #[test]
    fn a_co_funded_transfer_reads_as_one_intent_with_the_payment_and_both_changes() {
        let facts = tx_facts_json(&two_owner_tx()).expect("a co-funded transaction reads");
        assert!(facts.contains("\"understood\":true"), "{facts}");
        assert!(facts.contains("\"networkId\":\"preprod\""), "{facts}");
        assert!(
            facts.contains("\"segment\":1"),
            "one intent, at the transfer segment: {facts}"
        );
        assert!(
            facts.contains(&format!("\"ttlSecs\":{TTL}")),
            "the expiry every party signed over: {facts}"
        );
        // 2,000,000 + 4,000,000 pledged, so the recipient is paid 6,000,000 exactly.
        assert!(
            facts.contains(&format!(
                "{{\"colour\":\"{}\",\"value\":\"6000000\",\"owner\":\"{}\"}}",
                hex(&NIGHT),
                hex(&RECIPIENT)
            )),
            "the payment output: {facts}",
        );
        // And each contributor gets its remainder back: 1,000,000 to A, 1,000,000 to B.
        assert_eq!(
            facts.matches("\"value\":\"1000000\"").count(),
            2,
            "one change output each: {facts}"
        );
        assert!(
            facts.contains("\"calls\":[]") && facts.contains("\"deploys\":[]"),
            "{facts}"
        );
        assert!(facts.contains("\"otherActions\":0"), "{facts}");
    }

    /// ⚠️ **A shielded offer is a count, never an amount** — and a transfer that carries none must say
    /// so, rather than leaving a screen unable to tell "no shielded part" from "not read".
    #[test]
    fn an_unshielded_transfer_reports_no_shielded_part() {
        let facts = tx_facts_json(&two_owner_tx()).expect("reads");
        assert!(facts.contains("\"hasShielded\":false"), "{facts}");
        assert!(facts.contains("\"shieldedOutputs\":0"), "{facts}");
    }

    /// Bytes that are not a transaction are an **error**, not empty facts: "could not be read" and
    /// "does nothing" are different answers and only one of them belongs on a review screen.
    #[test]
    fn bytes_that_are_not_a_transaction_are_refused() {
        let err = tx_facts_json(&[1u8, 2, 3]).expect_err("must refuse");
        assert!(err.contains("not a proven"), "{err}");
    }

    /// An entry-point name is the only field here that is not hex, so it is the only one that can
    /// break the JSON. Escaped rather than trusted.
    #[test]
    fn a_string_with_a_quote_or_a_control_character_is_escaped() {
        assert_eq!(json_str("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(json_str("a\nb"), "\"a\\nb\"");
        assert_eq!(json_str("a\u{1}b"), "\"a\\u0001b\"");
    }

    /// An entry point that is not UTF-8 comes back as hex, never as replacement characters: a name
    /// that looks like a name and is not the one on chain is worse than admitting the bytes.
    #[test]
    fn a_non_utf8_entry_point_reads_as_hex() {
        assert_eq!(entry_point_of(&[0xff, 0xfe]), "\"fffe\"");
        assert_eq!(entry_point_of(b"claimName"), "\"claimName\"");
    }

    /// ⚠️ **The cross-check the review-from-bytes work owed.** This reader and
    /// `packages/tx-review/midnight-facts-wire.ts` are two halves of one answer, and until now
    /// nothing failed if either moved. The committed fixture is what both read: this test proves the
    /// Rust still emits it, and `midnight-facts-wire.test.ts` proves the parser still understands it.
    ///
    /// The transaction's *bytes* differ per run (binding randomness, randomised signatures); its
    /// *facts* do not, which is what makes an exact comparison the right check here.
    ///
    /// Regenerate with `UPDATE_FACTS_FIXTURE=1 cargo test the_facts_fixture` — never by hand, and
    /// never without reading what changed: a diff here is a change to what a person is shown before
    /// they sign.
    ///
    /// ⚠️ The file is excluded from biome in `biome.json`; pretty-printing it would break this exact
    /// comparison, and a formatter is not the right thing to be deciding a fixture's bytes.
    #[test]
    fn the_facts_fixture_still_matches_what_this_reader_emits() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tx-review/midnight-facts-fixture.json"
        );
        let emitted = tx_facts_json(&two_owner_tx()).expect("reads");
        if std::env::var("UPDATE_FACTS_FIXTURE").is_ok() {
            std::fs::write(path, &emitted).expect("write the fixture");
            return;
        }
        let committed = std::fs::read_to_string(path).expect("the committed fixture is readable");
        assert_eq!(
            emitted,
            committed.trim_end(),
            "the native facts reader has changed shape"
        );
    }
}
