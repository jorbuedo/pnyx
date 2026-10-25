//! A contract call that moves **shielded** value — the Zswap offer built beside the call.
//!
//! [`crate::tx`] assembles a call with no offer, and [`crate::tx::assemble_proven_tx_with_mints`]
//! adds *unshielded* outputs. Neither is enough for a circuit that touches Zswap, and the reason is
//! a ledger rule rather than a convenience: `Transaction::well_formed` collects the transcript's
//! `claimed_shielded_receives`, `claimed_nullifiers` and `claimed_shielded_spends` and requires each
//! to be matched by a real offer element **in the same intent and the same phase**
//! (`midnight-ledger` 8.1.0 `verify.rs`). A call with the right transcript and no offer is rejected
//! as `Malformed::EffectsCheckFailure` — and **neither a circuit proof nor `QueryContext::query` can
//! catch it**, because both see a transcript that is internally consistent. The unshielded mint path
//! learned the same lesson at the cost of one on-chain submission.
//!
//! ⚠️ **The offer goes in the FALLIBLE slot**, because [`crate::preimage::build_prototype`] puts the
//! transcript there. The effects check keys on `(segment, phase)`, so a guaranteed offer cannot
//! satisfy a fallible claim however well-formed it is on its own.
//!
//! **What the circuit does, and what the wallet does, are different halves.** The driver's
//! `ZswapLocalState` says which coins the *circuit* creates and spends; those become the offer's
//! contract-owned elements and are fully determined. What it does **not** say is where the value
//! comes from: a circuit that hands a coin to a treasury has created value the offer must balance,
//! and only the wallet can. So this module reads the circuit's half from the caller and funds the
//! rest from our own coins — the same first-fit selection [`crate::wallet`] uses for a transfer.
//!
//! **Routing is the ledger's own rule, not a shape special to one circuit.** A circuit output that
//! is contract-owned *and* whose coin the circuit also spends is a **`Transient`** — created and
//! consumed in one transaction, carrying both a commitment and a nullifier. Everything else is a
//! plain output. That is exactly how `midnight-js` pairs them, and it means a future shielded
//! circuit needs no new code here.
//!
//! @module

use std::io;
use std::path::PathBuf;

use futures::executor::block_on;
use midnight_base_crypto::hash::HashOutput;
use midnight_base_crypto::signatures::Signature;
use midnight_base_crypto::time::Timestamp;
use midnight_coin_structure::coin::PublicKey as CoinPublicKey;
use midnight_coin_structure::coin::QualifiedInfo as QualifiedCoinInfo;
use midnight_coin_structure::coin::{Info as CoinInfo, Nonce, ShieldedTokenType};
use midnight_coin_structure::contract::ContractAddress;
use midnight_ledger::construct::ContractCallPrototype;
use midnight_coin_structure::coin::{PublicAddress, TokenType};
use midnight_ledger::structure::{
    Intent, ProofPreimageMarker, Transaction, UnshieldedOffer, UtxoOutput,
};
use midnight_onchain_runtime::context::ClaimedUnshieldedSpendsKey;
use midnight_storage::arena::Sp;
use midnight_storage::storage::Array as StorageArray;
use midnight_onchain_runtime::cost_model::INITIAL_COST_MODEL;
use midnight_serialize::tagged_serialize;
use midnight_storage::storage::HashMap as StorageHashMap;
use midnight_transient_crypto::commitment::PedersenRandomness;
use midnight_transient_crypto::encryption::PublicKey as EncryptionPublicKey;
use midnight_transient_crypto::proofs::{
    KeyLocation, ProofPreimage, ProvingKeyMaterial, Resolver,
};
use midnight_zkir::LocalProvingProvider;
use midnight_zswap::{Delta, Offer, Output, Transient};
use rand::rngs::OsRng;

use crate::state_read::DB;
use crate::wallet::{DirParams, DirResolver};

type UnprovenIntent = Intent<Signature, ProofPreimageMarker, PedersenRandomness, DB>;

/// A coin exactly as the driver's `ZswapLocalState` carries it: three fields and, for a coin the
/// circuit *spends*, the Merkle index it is spent at.
///
/// ⚠️ An immediately-spent coin — one created in this same transaction, which is what
/// `sendImmediateShielded` produces — carries `mt_index: 0`, because the tree it is proved against
/// is a blank one holding just its own commitment. Taking the value from the caller rather than
/// assuming zero keeps this honest if a circuit ever spends a *ledger* coin instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CircuitCoin {
    pub nonce: [u8; 32],
    pub color: [u8; 32],
    pub value: u128,
    pub mt_index: u64,
}

impl CircuitCoin {
    fn info(&self) -> CoinInfo {
        CoinInfo {
            nonce: Nonce(HashOutput(self.nonce)),
            type_: ShieldedTokenType(HashOutput(self.color)),
            value: self.value,
        }
    }

    fn qualified(&self) -> QualifiedCoinInfo {
        self.info().qualify(self.mt_index)
    }

    /// Two coins are the same note iff all three fields agree; the Merkle index is *where* it is,
    /// not *what* it is.
    fn same_note(&self, other: &Self) -> bool {
        self.nonce == other.nonce && self.color == other.color && self.value == other.value
    }
}

/// Where a coin the circuit created is addressed.
///
/// ⚠️ **A user recipient carries two keys and the second is optional.** The coin public key says who
/// may spend it; the **encryption** key is what lets them *find* it by scanning. A circuit's
/// `ZswapCoinPublicKey` is only the first, so a caller that has just that must pass `None` — and the
/// recipient then has no way to discover the coin except being told its three fields out of band.
/// Supply the encryption key whenever the recipient's full shielded address is known.
#[derive(Clone, Copy, Debug)]
pub enum CircuitRecipient {
    User {
        coin_public_key: [u8; 32],
        encryption_public_key: Option<[u8; 32]>,
    },
    Contract([u8; 32]),
}

/// One entry of the driver's `ZswapLocalState.outputs`.
#[derive(Clone, Copy, Debug)]
pub struct CircuitOutput {
    pub coin: CircuitCoin,
    pub recipient: CircuitRecipient,
}

pub struct ShieldedCallRequest<'a> {
    /// The validated call, transcript and all — from [`crate::preimage::build_prototype`].
    pub prototype: ContractCallPrototype<DB>,
    /// `ZswapLocalState.inputs` — the coins the **circuit** spends.
    pub circuit_inputs: &'a [CircuitCoin],
    /// `ZswapLocalState.outputs` — the coins the **circuit** creates, and who they are addressed to.
    pub circuit_outputs: &'a [CircuitOutput],
    /// Our own wallet, which funds whatever the circuit's outputs cost, and the key that spends it.
    pub state: &'a [u8],
    pub zswap_role_key: &'a [u8; 32],
    /// The contract circuit's own artifacts.
    pub zkir: &'a [u8],
    pub prover_key: &'a [u8],
    pub verifier_key: &'a [u8],
    /// `{spend,output,sign}.{bzkir,prover,verifier}` — the ledger's protocol circuits.
    pub zswap_artifact_dir: &'a str,
    /// Holds `bls_midnight_2p<K>`. ⚠️ A **directory**, not one file: a shielded call proves circuits
    /// at three different Ks (the contract's own, zswap spend at 15, zswap output at 14), so the
    /// single-SRS provider the plain call path uses would serve the wrong one to two of them.
    pub params_dir: &'a str,
    pub network_id: &'a str,
    pub ttl_secs: u64,
    pub segment: u16,
}

/// Serves the contract's circuit by name and delegates everything else to the zswap directory.
///
/// The ledger asks this resolver about **every** circuit in the transaction, so neither half can
/// answer for the other: `DirResolver` already returns `None` for a name it does not recognise,
/// which is what makes the delegation safe rather than a fallback that hides a missing key.
struct CallAndZswapResolver {
    key_location: String,
    material: ProvingKeyMaterial,
    zswap: DirResolver,
}

impl Resolver for CallAndZswapResolver {
    async fn resolve_key(&self, key: KeyLocation) -> io::Result<Option<ProvingKeyMaterial>> {
        if *key.0 == *self.key_location {
            return Ok(Some(self.material.clone()));
        }
        self.zswap.resolve_key(key).await
    }
}

/// Build, fund and prove a contract call that moves shielded value.
///
/// Returns the tagged proven-unbound transaction and the wallet state with its spends marked
/// pending — both, because a caller that took the transaction and dropped the state would select the
/// same notes for its next call and produce a double spend the ledger rejects.
pub fn build_shielded_call_tx(request: ShieldedCallRequest<'_>) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut state = crate::wallet::decode(request.state)?;
    let keys = crate::wallet::keys_from(request.zswap_role_key);

    // ── The circuit's half ───────────────────────────────────────────────────────────────────
    //
    // Fully determined by the transcript the driver already produced. Nothing here is a choice.
    let mut offer_outputs = Vec::new();
    let mut offer_transients = Vec::new();
    // What the circuit's plain outputs cost, per colour — the deficit our own coins must cover.
    let mut owed: Vec<([u8; 32], u128)> = Vec::new();

    for out in request.circuit_outputs {
        let coin = out.coin.info();
        match out.recipient {
            CircuitRecipient::Contract(addr) => {
                let address = ContractAddress(HashOutput(addr));
                let output =
                    Output::new_contract_owned(&mut OsRng, &coin, Some(request.segment), address)
                        .map_err(|e| format!("build contract-owned output: {e:?}"))?;
                // Created *and* spent here? Then it is a transient, and its nullifier is what the
                // transcript's `claimed_nullifiers` is waiting for.
                match request
                    .circuit_inputs
                    .iter()
                    .find(|i| i.same_note(&out.coin))
                {
                    Some(spent) => offer_transients.push(
                        Transient::new_from_contract_owned_output(
                            &mut OsRng,
                            &spent.qualified(),
                            Some(request.segment),
                            output,
                        )
                        .map_err(|e| format!("build transient: {e:?}"))?,
                    ),
                    None => {
                        offer_outputs.push(output);
                        add_owed(&mut owed, out.coin.color, out.coin.value);
                    }
                }
            }
            CircuitRecipient::User {
                coin_public_key,
                encryption_public_key,
            } => {
                let epk = match encryption_public_key {
                    None => None,
                    Some(bytes) => Some(parse_encryption_key(&bytes)?),
                };
                offer_outputs.push(
                    Output::new(
                        &mut OsRng,
                        &coin,
                        Some(request.segment),
                        &CoinPublicKey(HashOutput(coin_public_key)),
                        epk,
                    )
                    .map_err(|e| format!("build recipient output: {e:?}"))?,
                );
                add_owed(&mut owed, out.coin.color, out.coin.value);
            }
        }
    }

    // ⚠️ A circuit input that is **not** paired into a transient would be a ledger coin the contract
    // spends, which needs the real commitment tree rather than the blank one a transient builds.
    // Nothing of ours does that yet, and guessing at it would produce an input whose Merkle path
    // proves against a tree the chain does not share — so it is refused by name.
    for input in request.circuit_inputs {
        let paired = request
            .circuit_outputs
            .iter()
            .any(|o| o.coin.same_note(input) && matches!(o.recipient, CircuitRecipient::Contract(_)));
        if !paired {
            return Err(
                "this circuit spends a shielded coin it did not create in the same transaction, \
                 which this builder does not serve"
                    .to_string(),
            );
        }
    }

    // ── Our half: fund the deficit ───────────────────────────────────────────────────────────
    let mut offer_inputs = Vec::new();
    let mut deltas = Vec::new();
    for (color, needed) in owed {
        let token = ShieldedTokenType(HashOutput(color));
        let (coins, change) = crate::wallet::select_coins(&state, color, needed)?;
        let mut spent: u128 = 0;
        for coin in &coins {
            let (advanced, input) = state
                .spend(&mut OsRng, &keys, coin, Some(request.segment))
                .map_err(|e| format!("spend coin at index {}: {e:?}", coin.mt_index))?;
            state = advanced;
            spent = spent.saturating_add(coin.value);
            offer_inputs.push(input);
        }
        if change > 0 {
            let change_coin = CoinInfo {
                nonce: Nonce(HashOutput(crate::wallet::random_nonce())),
                type_: token,
                value: change,
            };
            offer_outputs.push(
                Output::new(
                    &mut OsRng,
                    &change_coin,
                    Some(request.segment),
                    &keys.coin_public_key(),
                    // Our own encryption key, so an ordinary scan finds the change. Omitting it
                    // would strand our own money exactly the way an unaddressable coin does.
                    Some(keys.enc_public_key()),
                )
                .map_err(|e| format!("build change output: {e:?}"))?,
            );
            state = state.watch_for(&keys.coin_public_key(), &change_coin);
        }
        // Spent in, created out. A transient nets zero by construction and is deliberately not
        // counted: it is both halves of itself.
        deltas.push(Delta {
            token_type: token,
            value: (spent as i128) - (needed as i128) - (change as i128),
        });
    }

    let offer = Offer {
        inputs: offer_inputs.into(),
        outputs: offer_outputs.into(),
        transient: offer_transients.into(),
        deltas: deltas.into(),
    };

    // ── The unshielded half the same circuit also claims ─────────────────────────────────────
    //
    // ⚠️ **A shielded call does not escape the unshielded rule.** `buyPermitShielded` forwards a coin
    // *and* mints a permit, and the mint declares `claimed_unshielded_spends[(type, owner)]`, which
    // `Transaction::well_formed` requires a real `UtxoOutput` to match in the same intent and phase —
    // the check `assemble_proven_tx_with_mints` exists for, and which cost one on-chain submission to
    // find. Getting the shielded half right and stopping there produces a transaction the node
    // rejects for the other one.
    //
    // Derived from the transcript rather than taken from the caller: the two cannot then disagree,
    // and a circuit that mints something this builder was not told about still balances.
    let mints = unshielded_mints(&request.prototype)?;

    // ── Assemble ─────────────────────────────────────────────────────────────────────────────
    let key_location = request.prototype.key_location.0.to_string();
    let mut intent: UnprovenIntent =
        UnprovenIntent::empty(&mut OsRng, Timestamp::from_secs(request.ttl_secs))
            .add_call::<ProofPreimage>(request.prototype);
    if !mints.is_empty() {
        let mut outputs = StorageArray::<UtxoOutput, DB>::new();
        for output in &mints {
            outputs = outputs.push(output.clone());
        }
        // Outputs and no inputs, which is what a mint is: the contract creates the value, so there
        // is nothing to sign and `UnshieldedOffer::well_formed`'s one-signature-per-input holds
        // vacuously. Fallible, to match the phase the transcript is in.
        intent.fallible_unshielded_offer = Some(Sp::new(UnshieldedOffer {
            inputs: StorageArray::new(),
            outputs,
            signatures: StorageArray::new(),
        }));
    }
    let intents = StorageHashMap::<u16, UnprovenIntent, DB>::new().insert(request.segment, intent);
    // ⚠️ Guaranteed `None`, fallible keyed by the same segment the call is at — the effects check
    // matches on both, and the transcript lives in the fallible slot.
    let fallible = StorageHashMap::new().insert(request.segment, offer);
    let tx = Transaction::new(request.network_id.to_string(), intents, None, fallible);

    let resolver = CallAndZswapResolver {
        key_location,
        material: ProvingKeyMaterial {
            prover_key: request.prover_key.to_vec(),
            verifier_key: request.verifier_key.to_vec(),
            ir_source: request.zkir.to_vec(),
        },
        zswap: DirResolver {
            dir: PathBuf::from(request.zswap_artifact_dir),
        },
    };
    let params = DirParams {
        dir: PathBuf::from(request.params_dir),
    };
    let provider = LocalProvingProvider {
        rng: OsRng,
        resolver: &resolver,
        params: &params,
    };

    crate::diag::note("shielded call: proving");
    let proven = block_on(tx.prove(provider, &INITIAL_COST_MODEL))
        .map_err(|e| format!("prove shielded contract call: {e:?}"))?;
    crate::diag::note("shielded call: proved");

    let mut bytes = Vec::new();
    tagged_serialize(&proven, &mut bytes)
        .map_err(|e| format!("serialize shielded contract call: {e}"))?;
    Ok((bytes, crate::wallet::encode(&state)?))
}

/// The `UtxoOutput`s a call's own transcript says it mints.
///
/// ⚠️ A claim addressed to a **contract** is refused rather than dropped: `UtxoOutput` names a
/// `UserAddress`, so there is no output shape that satisfies such a claim, and emitting nothing
/// would produce a transaction rejected at the node for a reason nothing here pointed at.
fn unshielded_mints(prototype: &ContractCallPrototype<DB>) -> Result<Vec<UtxoOutput>, String> {
    let Some(transcript) = prototype.fallible_public_transcript.as_ref() else {
        return Ok(Vec::new());
    };
    let mut mints = Vec::new();
    for entry in transcript.effects.claimed_unshielded_spends.iter() {
        let (key, amount) = (entry.0.clone(), entry.1.clone());
        let ClaimedUnshieldedSpendsKey(token, address) = *key;
        let TokenType::Unshielded(type_) = token else {
            return Err("a call claims an unshielded spend of a token that is not unshielded".to_string());
        };
        let PublicAddress::User(owner) = address else {
            return Err(
                "a call mints to a contract, which no `UtxoOutput` can address — this builder serves \
                 mints to users"
                    .to_string(),
            );
        };
        mints.push(UtxoOutput {
            value: *amount,
            owner,
            type_,
        });
    }
    Ok(mints)
}

fn add_owed(owed: &mut Vec<([u8; 32], u128)>, color: [u8; 32], value: u128) {
    match owed.iter_mut().find(|(c, _)| *c == color) {
        Some((_, total)) => *total = total.saturating_add(value),
        None => owed.push((color, value)),
    }
}

/// ⚠️ **Untagged, 32 bytes** — the second half of a shielded address, which is how the address
/// encodes it. Expecting a tagged value here made every real address fail with a header-tag error,
/// which is the same trap `build_transfer_tx` documents.
fn parse_encryption_key(bytes: &[u8; 32]) -> Result<EncryptionPublicKey, String> {
    use midnight_serialize::Deserializable;
    Deserializable::deserialize(&mut &bytes[..], 0)
        .map_err(|e| format!("deserialize recipient encryption key: {e}"))
}
