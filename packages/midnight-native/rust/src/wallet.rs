//! Shielded wallet state — the coin side of a Midnight wallet, on device.
//!
//! Hermes has no WebAssembly, so the wallet SDK cannot run in the app at all. What it *does* is
//! nearly all `midnight-zswap`'s `local::State`, which this crate already compiles: tracking unspent
//! coins, fast-forwarding the commitment tree, decrypting output ciphertexts, and producing spend
//! inputs. This module is the seam around that type, not a reimplementation of it — every rule about
//! what a coin is lives upstream.
//!
//! **State crosses the bridge as bytes, not as a handle.** Each call deserializes, acts, and returns
//! the new serialized state, so no Rust object outlives a call and the host owns persistence. It
//! costs a round trip through `tagged_serialize` per operation; the alternative — a handle table
//! keyed by an integer — leaks whenever the JS side is torn down, which on React Native happens on
//! every reload.
//!
//! Coins cross as their three fields (nonce, colour, value) rather than a serialized `CoinInfo`,
//! because the values a contract mint hands back are exactly those three and the host has them as
//! plain data. See [`Coin`].

use midnight_base_crypto::hash::HashOutput;
use midnight_base_crypto::signatures::Signature;
use midnight_base_crypto::signatures::SigningKey;
use midnight_base_crypto::time::Timestamp;
use midnight_coin_structure::coin::PublicKey as CoinPublicKey;
use midnight_coin_structure::coin::{Info as CoinInfo, Nonce, ShieldedTokenType};
use midnight_ledger::structure::{ProofMarker, ProofPreimageMarker, Transaction};
use midnight_serialize::{tagged_deserialize, tagged_serialize, Deserializable, Serializable};
use midnight_transient_crypto::commitment::{PedersenRandomness, PureGeneratorPedersen};
use midnight_transient_crypto::encryption::PublicKey as EncryptionPublicKey;
use midnight_transient_crypto::merkle_tree::MerkleTreeCollapsedUpdate;
use midnight_zswap::keys::{SecretKeys, Seed};
use midnight_zswap::local::State;
use midnight_zswap::CoinCiphertext;

use std::io;
use std::path::{Path, PathBuf};

use futures::executor::block_on;
use midnight_coin_structure::coin::QualifiedInfo as QualifiedCoinInfo;
use midnight_ledger::structure::Intent;
use midnight_onchain_runtime::cost_model::INITIAL_COST_MODEL;
use midnight_storage::storage::HashMap as StorageHashMap;
use midnight_transient_crypto::proofs::{
    KeyLocation, ParamsProver, ParamsProverProvider, ProvingKeyMaterial, Resolver,
};
use midnight_zkir::LocalProvingProvider;
use midnight_zswap::{Delta, Offer, Output};
use rand::rngs::OsRng;
use rand::Rng;

use crate::state_read::DB;

/// Transfers live in segment 1; segment 0 is reserved and rejected.
const TRANSFER_SEGMENT: u16 = 1;

type UnprovenTransferIntent = Intent<Signature, ProofPreimageMarker, PedersenRandomness, DB>;

/// A fresh coin nonce. Uniqueness is the caller's problem and the ledger's rule: a reused nonce
/// produces a duplicate commitment, which is rejected.
pub(crate) fn random_nonce() -> [u8; 32] {
    OsRng.r#gen()
}

/// The wallet's shielded state, as the host stores it.
pub type WalletState = State<DB>;

/// A coin as three plain fields: 32-byte nonce, 32-byte colour, and a `u128` value.
///
/// `value` is `u128` because that is what a `CoinInfo` holds. Note the protocol asymmetry a caller
/// will meet elsewhere: a contract *mint* caps at `Uint<64>` while sends take `Uint<128>`.
pub struct Coin {
    pub nonce: [u8; 32],
    pub color: [u8; 32],
    pub value: u128,
}

impl From<&Coin> for CoinInfo {
    fn from(c: &Coin) -> Self {
        CoinInfo {
            nonce: Nonce(HashOutput(c.nonce)),
            type_: ShieldedTokenType(HashOutput(c.color)),
            value: c.value,
        }
    }
}

pub(crate) fn keys_from(zswap_role_key: &[u8; 32]) -> SecretKeys {
    SecretKeys::from(Seed::from(*zswap_role_key))
}

pub(crate) fn decode(state_bytes: &[u8]) -> Result<WalletState, String> {
    tagged_deserialize(&mut &state_bytes[..]).map_err(|e| format!("deserialize wallet state: {e}"))
}

pub(crate) fn encode(state: &WalletState) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    tagged_serialize(state, &mut out).map_err(|e| format!("serialize wallet state: {e}"))?;
    Ok(out)
}

/// A fresh, empty wallet state: no coins, a blank commitment tree, `first_free` at 0.
pub fn state_new() -> Result<Vec<u8>, String> {
    encode(&WalletState::new())
}

/// Fast-forward the commitment tree across indices this wallet has no coins in.
///
/// The indexer serves these as `zswapMerkleTreeCollapsedUpdate(startIndex, endIndex)`. Applying one
/// is what keeps the local tree consistent with the chain without downloading every leaf.
///
/// ⚠️ **An update is NOT self-validating, and this doc used to say it was.** Deserialization checks
/// the framing; the hashes it carries are taken on trust. Measured against a real preprod update,
/// **311 of 377 single-byte flips were accepted** and produced a tree that differs from the chain's
/// while looking entirely healthy — the exact failure this doc claimed was prevented, surfacing much
/// later as a rejected transaction with no local explanation. Compare [`state_merkle_root`] against
/// the indexer's `zswapMerkleTreeRoot` to actually know.
pub fn state_apply_collapsed_update(
    state_bytes: &[u8],
    update_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let state = decode(state_bytes)?;
    let update: MerkleTreeCollapsedUpdate = tagged_deserialize(&mut &update_bytes[..])
        .map_err(|e| format!("deserialize collapsed update: {e}"))?;
    let next = state
        .apply_collapsed_update(&update)
        .map_err(|e| format!("apply collapsed update: {e:?}"))?;
    encode(&next)
}

/// Take ownership of a coin whose values we already know, inserting it at `first_free`.
///
/// **This is how a coin with no ciphertext is ever spendable.**
///
/// ⚠️ **Narrower than it used to say here.** This doc claimed "a contract-initiated mint or send
/// creates no output ciphertext", which is too broad: the ciphertext is attached by the transaction
/// *builder*, off chain, not by the circuit. A coin is discoverable by scanning iff whoever built
/// its transaction knew the recipient's **encryption** key — so a contract mint addressed to you is
/// found by an ordinary scan (`tests/scan_finds_a_minted_coin.rs`, against a real preprod mint).
///
/// What is left for this function is the case where the builder could not know that key: a contract
/// forwarding to a treasury that publishes only a coin public key. There the transaction is the only
/// place the coin's values exist, and whoever built it captures them and hands them here.
pub fn state_insert_coin(
    state_bytes: &[u8],
    zswap_role_key: &[u8; 32],
    coin: &Coin,
) -> Result<Vec<u8>, String> {
    let state = decode(state_bytes)?;
    let next = state
        .insert_coin(&keys_from(zswap_role_key), CoinInfo::from(coin))
        .map_err(|e| format!("insert coin: {e:?}"))?;
    encode(&next)
}

/// Expect a coin at an index we have not reached yet, so `apply` claims it when it arrives.
///
/// The difference from [`state_insert_coin`] is *when* the coin lands: `watch_for` records a pending
/// output that a later `apply` matches by commitment, which is the right shape for a coin promised by
/// a transaction that has not been applied to this wallet's view yet.
pub fn state_watch_for(
    state_bytes: &[u8],
    zswap_role_key: &[u8; 32],
    coin: &Coin,
) -> Result<Vec<u8>, String> {
    let state = decode(state_bytes)?;
    let keys = keys_from(zswap_role_key);
    encode(&state.watch_for(&keys.coin_public_key(), &CoinInfo::from(coin)))
}

/// Try to open an output ciphertext with this wallet's encryption key.
///
/// The local-scan sync path: for every output on chain, ask whether it is ours. `None` is the
/// overwhelmingly common answer and is not an error.
pub fn try_decrypt(
    zswap_role_key: &[u8; 32],
    ciphertext_bytes: &[u8],
) -> Result<Option<Coin>, String> {
    let ciphertext: CoinCiphertext = tagged_deserialize(&mut &ciphertext_bytes[..])
        .map_err(|e| format!("deserialize coin ciphertext: {e}"))?;
    Ok(keys_from(zswap_role_key)
        .try_decrypt(&ciphertext)
        .map(|info| Coin {
            nonce: info.nonce.0 .0,
            color: info.type_.0 .0,
            value: info.value,
        }))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What the host renders and spends from: the tree cursor, per-colour totals, and every **spendable**
/// coin with the Merkle index a spend needs.
///
/// A coin spent by a transfer that has not confirmed yet is **excluded**, and counted under `pending`
/// instead. Upstream keeps such a coin in `coins` until `apply` sees its nullifier on chain, so a
/// summary that listed it would invite a second transfer to spend the same note — and report a balance
/// that cannot be sent.
///
/// Values are JSON **strings**, not numbers: a `u128` does not survive a JS `number`, and this is the
/// figure a balance is shown from.
pub fn state_summary_json(state_bytes: &[u8]) -> Result<String, String> {
    let state = decode(state_bytes)?;

    // Totals per colour, accumulated in declaration order so the output is stable across calls —
    // a map iteration order would reshuffle a rendered balance list for no reason.
    let mut totals: Vec<([u8; 32], u128)> = Vec::new();
    let mut coins: Vec<String> = Vec::new();
    let mut pending: u32 = 0;
    for (nullifier, coin) in state.coins.iter() {
        if state.pending_spends.get(&nullifier).is_some() {
            pending += 1;
            continue;
        }
        let color = coin.type_.0 .0;
        match totals.iter_mut().find(|(c, _)| *c == color) {
            Some((_, total)) => *total = total.saturating_add(coin.value),
            None => totals.push((color, coin.value)),
        }
        coins.push(format!(
            "{{\"nonce\":\"{}\",\"color\":\"{}\",\"value\":\"{}\",\"mtIndex\":{}}}",
            hex(&coin.nonce.0 .0),
            hex(&color),
            coin.value,
            coin.mt_index,
        ));
    }
    let balances: Vec<String> = totals
        .iter()
        .map(|(color, total)| format!("{{\"color\":\"{}\",\"value\":\"{}\"}}", hex(color), total))
        .collect();

    Ok(format!(
        "{{\"firstFree\":{},\"pending\":{},\"balances\":[{}],\"coins\":[{}]}}",
        state.first_free,
        pending,
        balances.join(","),
        coins.join(","),
    ))
}

/// The local commitment tree's root, in the indexer's own encoding.
///
/// ⚠️ **This is the only way to tell a correctly-synced wallet from a plausibly-wrong one.** The
/// docs on [`state_apply_collapsed_update`] used to claim an update "carries its own consistency
/// check, so a wrong one is rejected rather than producing a tree that silently fails to prove".
/// Measured, that is false: of 377 single-byte flips in a real preprod update, **311 were accepted**
/// (`tests/birthday_sync_places_coins_at_chain_indices.rs`). Deserialization validates the framing,
/// not the hashes. So a wallet that fast-forwards to a birthday has no local evidence its tree is
/// the chain's — unless it compares this against the `zswapMerkleTreeRoot` the indexer reports for
/// the last transaction it applied.
///
/// `None` from upstream means the tree has never been rehashed, which cannot happen after a
/// collapsed update or an applied transaction; it is reported as an error rather than as an empty
/// root, because an empty answer would compare unequal and read as corruption.
pub fn state_merkle_root(state_bytes: &[u8]) -> Result<String, String> {
    let state = decode(state_bytes)?;
    let root = state
        .merkle_tree
        .rehash()
        .root()
        .ok_or_else(|| "the commitment tree has no root".to_string())?;
    let mut out = Vec::new();
    Serializable::serialize(&root, &mut out).map_err(|e| format!("serialize merkle root: {e}"))?;
    Ok(hex(&out))
}

/// A transaction as it appears on chain: proven, signed, and bound.
///
/// This is the shape the indexer's `Transaction.raw` deserializes to, and the same one
/// `@midnight-ntwrk/ledger-v8` reconstructs with `('signature', 'proof', 'binding')`.
///
/// The binding is `PureGeneratorPedersen`, **not** `Pedersen`: a bound transaction carries the
/// Fiat-Shamir proof of exponent knowledge alongside the commitment, and its tag says so
/// (`pedersen-schnorr[v1]`). Using the plain commitment compiles and then fails on every real
/// transaction with a header-tag mismatch — which is how this was found, on a device, against
/// preprod.
type ChainTransaction = Transaction<Signature, ProofMarker, PureGeneratorPedersen, DB>;

/// Apply a confirmed transaction, claiming coins for us and retiring ones we spent.
///
/// **Only successful sections may be applied.** `succeeded_segments` lists the fallible segments the
/// ledger accepted, or `None` for "every section", which is what a fully successful transaction means.
/// The guaranteed section is always applied because a transaction that reached a block has it by
/// definition. Applying a failed segment would insert a coin the ledger never created, and the wallet
/// would then produce spend proofs against a tree the chain does not share — a failure that surfaces
/// much later, as a rejected transaction with no local explanation.
///
/// `None` rather than "the list of all ids" because the caller cannot always enumerate them: the
/// indexer reports per-segment results only for a *partial* success, so on a full success the segments
/// are known to have succeeded without being listed.
///
/// The commitment tree advances over *every* output in an applied section, ours or not, because index
/// order is what the tree is. Outputs that are not ours are collapsed rather than stored.
pub fn state_apply_transaction(
    state_bytes: &[u8],
    zswap_role_key: &[u8; 32],
    tx_bytes: &[u8],
    succeeded_segments: Option<&[u16]>,
) -> Result<Vec<u8>, String> {
    let state = decode(state_bytes)?;
    let tx: ChainTransaction = tagged_deserialize(&mut &tx_bytes[..])
        .map_err(|e| format!("deserialize transaction: {e}"))?;
    let keys = keys_from(zswap_role_key);

    let Transaction::Standard(stx) = tx else {
        // A rewards claim carries no zswap offer, so there is nothing here to apply. Not an error:
        // the sync loop meets these on any chain where someone claims block rewards.
        return encode(&state);
    };

    let mut next = state;
    if let Some(guaranteed) = stx.guaranteed_coins.as_ref() {
        next = next
            .apply(&keys, guaranteed)
            .map_err(|e| format!("apply guaranteed coins: {e:?}"))?;
    }
    // Segment order matters — the tree is indexed by position, so applying segment 2 before segment 1
    // would place coins at indices the chain assigned to other commitments.
    let mut segments: Vec<u16> = match succeeded_segments {
        Some(ids) => ids.to_vec(),
        None => stx.fallible_coins.keys().collect(),
    };
    segments.sort_unstable();
    for segment in segments {
        if let Some(offer) = stx.fallible_coins.get(&segment) {
            next = next
                .apply(&keys, &offer)
                .map_err(|e| format!("apply fallible coins for segment {segment}: {e:?}"))?;
        }
    }
    encode(&next)
}

/// A coin on the wire: `nonce(32) ‖ color(32) ‖ value(16, little-endian u128)`.
///
/// Fixed-width and positional rather than JSON, because every field is fixed-width and a length
/// mismatch is then a decode error instead of a field that silently defaults.
pub const COIN_WIRE_LEN: usize = 80;

fn parse_coin(arg: &[u8]) -> Result<Coin, String> {
    if arg.len() != COIN_WIRE_LEN {
        return Err(format!(
            "coin must be {COIN_WIRE_LEN} bytes (nonce||color||value), got {}",
            arg.len()
        ));
    }
    let mut nonce = [0u8; 32];
    let mut color = [0u8; 32];
    let mut value = [0u8; 16];
    nonce.copy_from_slice(&arg[0..32]);
    color.copy_from_slice(&arg[32..64]);
    value.copy_from_slice(&arg[64..80]);
    Ok(Coin {
        nonce,
        color,
        value: u128::from_le_bytes(value),
    })
}

/// Every operation that returns a **new state**, behind one bridge entry point.
///
/// Grouped by return shape rather than split per operation because each bridge function costs a C
/// export, a JNI export, a header declaration, a Kotlin `external fun`, a Swift `@_silgen_name` and a
/// TS wrapper — six hand-written halves, two of which only a device build can check. The host wraps
/// each op in its own typed function, so the stringly-typed seam stays inside this file and
/// `midnight-native/src/index.ts`.
///
/// An unrecognised `op` is an error, never a default: a silently ignored operation would return the
/// state unchanged, which reads as "nothing arrived" rather than "this build cannot do that".
pub fn state_op(
    op: &str,
    state: &[u8],
    zswap_role_key: &[u8; 32],
    arg: &[u8],
) -> Result<Vec<u8>, String> {
    match op {
        "new" => state_new(),
        "applyCollapsedUpdate" => state_apply_collapsed_update(state, arg),
        "insertCoin" => state_insert_coin(state, zswap_role_key, &parse_coin(arg)?),
        "watchFor" => state_watch_for(state, zswap_role_key, &parse_coin(arg)?),
        // `arg` is `segments(2 bytes each, little-endian) ‖ transaction`, length-prefixed by a
        // leading u16 count: the succeeded-segment list is data the ledger reports per transaction,
        // so it cannot be inferred here. A count of `0xffff` means *every* section — a full success,
        // where the indexer reports no per-segment detail because none of it failed.
        "applyTransaction" => {
            if arg.len() < 2 {
                return Err(
                    "applyTransaction arg must start with a 2-byte segment count".to_string(),
                );
            }
            let raw_count = u16::from_le_bytes([arg[0], arg[1]]);
            if raw_count == u16::MAX {
                return state_apply_transaction(state, zswap_role_key, &arg[2..], None);
            }
            let count = raw_count as usize;
            let end = 2 + count * 2;
            if arg.len() < end {
                return Err(format!(
                    "applyTransaction declares {count} segments but the arg holds {} bytes",
                    arg.len()
                ));
            }
            let segments: Vec<u16> = arg[2..end]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            state_apply_transaction(state, zswap_role_key, &arg[end..], Some(&segments))
        }
        // DUST state, prefixed so the two subjects cannot collide in one dispatcher. ⚠️ The key slot
        // carries the **DUST** role key for these — see `crate::dust`.
        other if other.starts_with("dust:") => {
            crate::dust::state_op(other, state, zswap_role_key, arg)
        }
        other => Err(format!("unknown wallet state op: {other}")),
    }
}

/// Every operation that **reads**, returning JSON. Same grouping rationale as [`state_op`].
///
/// `tryDecrypt` returns `null` for an output that is not ours, which is the common case and not an
/// error — conflating the two would make a foreign coin look like a sync failure.
pub fn read_op(
    op: &str,
    state: &[u8],
    zswap_role_key: &[u8; 32],
    arg: &[u8],
) -> Result<String, String> {
    match op {
        "summary" => state_summary_json(state),
        // Quoted so every arm of this dispatcher returns JSON, as the doc above promises.
        "merkleRoot" => Ok(format!("\"{}\"", state_merkle_root(state)?)),
        "tryDecrypt" => Ok(match try_decrypt(zswap_role_key, arg)? {
            Some(coin) => format!(
                "{{\"nonce\":\"{}\",\"color\":\"{}\",\"value\":\"{}\"}}",
                hex(&coin.nonce),
                hex(&coin.color),
                coin.value,
            ),
            None => "null".to_string(),
        }),
        // **Sign arbitrary bytes with the role-0 Night key**, for the dApp connector's `signData`.
        //
        // ⚠️ The key slot carries the **Night** role key here, not a Zswap one — the parameter is named
        // for its first caller. Night is right because that is the key an unshielded address names, and
        // `SignDataOptions.keyType` is `'unshielded'`.
        //
        // `arg` is the message as raw bytes: the connector's `'hex' | 'base64' | 'text'` encoding is
        // decoded on the TypeScript side, where the rule is pure and testable, so this signs exactly
        // what it is given and never guesses at a text encoding.
        //
        // Widths are the API's, and they are the crate's own: a signature serializes to 64 bytes
        // (`r ‖ s`) and a verifying key to 32 (BIP-340 x-only). ⚠️ Signing is **randomised**
        // (`sign_with_rng`), so two signatures over one message differ — a caller must not treat one as
        // a stable identifier for the other.
        "signData" => {
            let signing_key = SigningKey::from_bytes(zswap_role_key)
                .map_err(|_| "malformed night role key".to_string())?;
            let signature = signing_key.sign(&mut OsRng, arg);
            let mut sig_bytes = Vec::new();
            Serializable::serialize(&signature, &mut sig_bytes)
                .map_err(|e| format!("serialize signature: {e}"))?;
            let mut key_bytes = Vec::new();
            Serializable::serialize(&signing_key.verifying_key(), &mut key_bytes)
                .map_err(|e| format!("serialize verifying key: {e}"))?;
            Ok(format!(
                "{{\"signature\":\"{}\",\"verifyingKey\":\"{}\"}}",
                hex(&sig_bytes),
                hex(&key_bytes),
            ))
        }
        // Not a wallet read at all — it needs neither the state nor the key — but it returns JSON, and
        // this export is grouped by return shape rather than by subject (see `state_op`). A separate
        // export would cost six hand-written bridge halves for one function.
        "txIdentifiers" => {
            let ids = crate::tx::proven_tx_identifiers(arg)?;
            let quoted: Vec<String> = ids.iter().map(|id| format!("\"{id}\"")).collect();
            Ok(format!("[{}]", quoted.join(",")))
        }
        // **What a transaction owes, straight from the ledger.** Same grouping rationale as
        // `txIdentifiers`: no state, no key, JSON out. It exists separately from
        // `walletBalanceUnsealedTransaction` because the host needs the figure *before* the user
        // approves — a review screen that showed nothing until after signing would be asking for
        // approval of an amount it had not named.
        "txBalance" => crate::balance::balance_entries_json(arg),
        // **What a transaction contains**, for the review that reads the bytes instead of trusting the
        // caller. Same grouping rationale as `txBalance`: no state, no key, JSON out. Separate from
        // `txBalance` because the two answer different questions — what the transaction *owes*, and
        // what it *does* — and a review needs both.
        "txFacts" => crate::facts::tx_facts_json(arg),
        // DUST reads. Neither needs a key: a balance is a function of the state and a time.
        other if other.starts_with("dust:") => {
            crate::dust::read_op(other, state, zswap_role_key, arg)
        }
        // Payment-contract reads: which tiers are free, and what the probed currency costs. Same
        // grouping rationale — a contract state in, JSON out, and no key at all.
        other if other.starts_with("payment:") => crate::payment::read_op(other, state, arg),
        // Handle-contract reads: who holds a name, and whether it still counts. ⚠️ One half of the
        // bidirectional rule — see `crate::handle`.
        other if other.starts_with("handle:") => crate::handle::read_op(other, state, arg),
        other => Err(format!("unknown wallet read op: {other}")),
    }
}

/// The protocol circuits, as files the host already fetched and hash-checked.
///
/// Upstream's `MidnightDataProvider` resolves these from `$MIDNIGHT_PP` or `$HOME/.cache` and re-checks
/// their hashes on every read. Neither is right here: Android has no meaningful `$HOME`, and the app's
/// artifact fetcher (`app/src/services/pnyx-artifacts.ts`) already verified every byte against
/// the manifest our origin publishes — the same hashes the `midnight-zswap` crate pins. So the device
/// passes **paths**, exactly as it does for contract circuits, and this reads them.
pub(crate) struct DirResolver {
    pub(crate) dir: PathBuf,
}

fn read_artifact(dir: &Path, file: &str) -> io::Result<Vec<u8>> {
    std::fs::read(dir.join(file))
}

impl Resolver for DirResolver {
    async fn resolve_key(&self, key: KeyLocation) -> io::Result<Option<ProvingKeyMaterial>> {
        // Only the three the ledger asks for. `None` rather than an error for anything else: the
        // prover asks this resolver about every circuit in the transaction, and a contract call's keys
        // legitimately live elsewhere.
        let circuit = match &*key.0 {
            "midnight/zswap/spend" => "spend",
            "midnight/zswap/output" => "output",
            "midnight/zswap/sign" => "sign",
            // Paying a fee from DUST proves this. It resolves to the same file name as the zswap
            // spend, which is why the host caches the two families in separate directories — see
            // `ensureDustArtifacts`.
            "midnight/dust/spend" => "spend",
            _ => return Ok(None),
        };
        Ok(Some(ProvingKeyMaterial {
            prover_key: read_artifact(&self.dir, &format!("{circuit}.prover"))?,
            verifier_key: read_artifact(&self.dir, &format!("{circuit}.verifier"))?,
            ir_source: read_artifact(&self.dir, &format!("{circuit}.bzkir"))?,
        }))
    }
}

/// The KZG SRS per K, read on demand from the shared params directory.
///
/// Per K, not one fixed set: the three circuits do not share a K (spend, output and sign measure 15, 14
/// and 13), so the single-SRS provider the contract-call path uses would serve the wrong one to two of
/// them.
pub(crate) struct DirParams {
    pub(crate) dir: PathBuf,
}

impl ParamsProverProvider for DirParams {
    async fn get_params(&self, k: u8) -> io::Result<ParamsProver> {
        let bytes = read_artifact(&self.dir, &format!("bls_midnight_2p{k}"))?;
        ParamsProver::read(&bytes[..])
            .map_err(|e| io::Error::other(format!("read KZG params for K={k}: {e}")))
    }
}

/// A shielded transfer, assembled and proven on device, ready for the sponsor to balance.
///
/// The Zswap offer balances **itself**: the coins spent equal the coins created, so the recipient's
/// output and our own change output are both built here. What the sponsor still adds is the DUST fee,
/// which is a separate ledger concern — so a shielded send needs no funded user wallet, only coins.
///
/// Coin selection is first-fit over the wallet's coins of that colour, in stored order. Deliberately
/// naive: a smarter policy is a privacy decision (which coins to link) rather than an arithmetic one,
/// and making it here would freeze it below the layer that should own it.
///
/// Every coin is spent in full and the remainder returns as change. Zswap has no partial spend — a
/// note is consumed or it is not — so "change" is not an optimisation, it is the only way to send less
/// than a coin holds.
///
/// The change output carries **our own encryption key**, so an ordinary scan finds it. Omitting it
/// would strand the remainder exactly the way a contract mint strands a coin ([`state_insert_coin`]).
pub struct TransferRequest<'a> {
    pub state: &'a [u8],
    pub zswap_role_key: &'a [u8; 32],
    /// Recipient's shielded address, split: coin public key ‖ encryption public key, 32 bytes each —
    /// exactly the two halves an `mn_shield-addr` decodes to.
    pub recipient_coin_public_key: [u8; 32],
    pub recipient_encryption_public_key: &'a [u8],
    pub color: [u8; 32],
    pub value: u128,
    pub network_id: &'a str,
    pub ttl_secs: u64,
    /// Directory holding `{spend,output,sign}.{bzkir,prover,verifier}`.
    pub artifact_dir: &'a str,
    /// Directory holding `bls_midnight_2p<K>`.
    pub params_dir: &'a str,
}

/// The coins to spend for `value`, or an error naming what is actually held.
///
/// Returns the exact shortfall rather than "insufficient funds": a caller that cannot say how much is
/// missing cannot tell a user whether to wait for a pending receive or to send less.
pub(crate) fn select_coins(
    state: &WalletState,
    color: [u8; 32],
    value: u128,
) -> Result<(Vec<QualifiedCoinInfo>, u128), String> {
    let mut chosen = Vec::new();
    let mut total: u128 = 0;
    for (nullifier, coin) in state.coins.iter() {
        if coin.type_.0 .0 != color {
            continue;
        }
        // A coin already spent by a transfer that has not confirmed yet stays in `coins` — upstream
        // only retires it when `apply` sees its nullifier on chain — so selection has to consult
        // `pending_spends` itself. Skipping this is a double spend: a second transfer built in the
        // window picks the same notes and the ledger rejects the whole thing.
        if state.pending_spends.get(&nullifier).is_some() {
            continue;
        }
        total = total.saturating_add(coin.value);
        chosen.push(*coin);
        if total >= value {
            return Ok((chosen, total - value));
        }
    }
    Err(format!(
        "holds {total} of this token, need {value} (short by {})",
        value.saturating_sub(total)
    ))
}

/// Build + prove a shielded transfer, returning the tagged proven-unbound transaction bytes and the
/// wallet state with the spends marked pending.
///
/// The state comes back changed on purpose: the spent coins move to `pending_spends`, so a second
/// transfer built before the first confirms cannot select the same notes and produce a double spend
/// the ledger would reject.
pub fn build_transfer_tx(request: TransferRequest<'_>) -> Result<(Vec<u8>, Vec<u8>), String> {
    let state = decode(request.state)?;
    let keys = keys_from(request.zswap_role_key);
    let (inputs, change) = select_coins(&state, request.color, request.value)?;

    // **Untagged**, 32 bytes: this is the second half of a shielded address, and that is how the
    // address encodes it (and how `shielded_public_keys` emits it). Expecting a tagged value here made
    // every real address fail with a header-tag error — found on the device, where the only source of a
    // recipient key *is* an address.
    if request.recipient_encryption_public_key.len() != 32 {
        return Err(format!(
            "recipient encryption key must be the 32 bytes an mn_shield-addr carries, got {}",
            request.recipient_encryption_public_key.len()
        ));
    }
    let recipient_epk: EncryptionPublicKey =
        Deserializable::deserialize(&mut &request.recipient_encryption_public_key[..], 0)
            .map_err(|e| format!("deserialize recipient encryption key: {e}"))?;
    let color = ShieldedTokenType(HashOutput(request.color));

    let mut next = state.clone();
    let mut offer_inputs = Vec::new();
    for coin in &inputs {
        let (advanced, input) = next
            .spend(&mut OsRng, &keys, coin, Some(TRANSFER_SEGMENT))
            .map_err(|e| format!("spend coin at index {}: {e:?}", coin.mt_index))?;
        next = advanced;
        offer_inputs.push(input);
    }

    let mut offer_outputs = Vec::new();
    let paid = CoinInfo {
        nonce: Nonce(HashOutput(random_nonce())),
        type_: color,
        value: request.value,
    };
    offer_outputs.push(
        Output::new(
            &mut OsRng,
            &paid,
            Some(TRANSFER_SEGMENT),
            &CoinPublicKey(HashOutput(request.recipient_coin_public_key)),
            Some(recipient_epk),
        )
        .map_err(|e| format!("build recipient output: {e:?}"))?,
    );
    if change > 0 {
        let change_coin = CoinInfo {
            nonce: Nonce(HashOutput(random_nonce())),
            type_: color,
            value: change,
        };
        offer_outputs.push(
            Output::new(
                &mut OsRng,
                &change_coin,
                Some(TRANSFER_SEGMENT),
                &keys.coin_public_key(),
                Some(keys.enc_public_key()),
            )
            .map_err(|e| format!("build change output: {e:?}"))?,
        );
        // Expect it back: the change output has a ciphertext, but watching for it means a confirmation
        // that arrives before the next full sync still lands the coin.
        next = next.watch_for(&keys.coin_public_key(), &change_coin);
    }

    let spent: u128 = inputs.iter().map(|c| c.value).sum();
    let offer = Offer {
        inputs: offer_inputs.into(),
        outputs: offer_outputs.into(),
        transient: vec![].into(),
        // Positive means more was spent than created. Here they are equal, so the delta is zero and
        // the offer needs no counterparty — which is what lets the sponsor balance only the fee.
        deltas: vec![Delta {
            token_type: color,
            value: (spent as i128) - (request.value as i128) - (change as i128),
        }]
        .into(),
    };

    let intent: UnprovenTransferIntent =
        UnprovenTransferIntent::empty(&mut OsRng, Timestamp::from_secs(request.ttl_secs));
    let intents =
        StorageHashMap::<u16, UnprovenTransferIntent, DB>::new().insert(TRANSFER_SEGMENT, intent);
    let tx: Transaction<Signature, ProofPreimageMarker, PedersenRandomness, DB> = Transaction::new(
        request.network_id.to_string(),
        intents,
        Some(offer),
        StorageHashMap::new(),
    );

    let resolver = DirResolver {
        dir: PathBuf::from(request.artifact_dir),
    };
    let params = DirParams {
        dir: PathBuf::from(request.params_dir),
    };
    let provider = LocalProvingProvider {
        rng: OsRng,
        params: &params,
        resolver: &resolver,
    };
    let proven = block_on(tx.prove(provider, &INITIAL_COST_MODEL))
        .map_err(|e| format!("prove transfer: {e:?}"))?;

    let mut bytes = Vec::new();
    tagged_serialize(&proven, &mut bytes).map_err(|e| format!("serialize transfer: {e}"))?;
    Ok((bytes, encode(&next)?))
}

/// [`build_transfer_tx`] for the bridges: hex/JSON in, JSON out (`{"tx":"…","state":"…"}`).
///
/// One entry point rather than folding this into [`state_op`]: a transfer needs ten arguments and
/// returns *two* values — the transaction to submit and the state with its spends marked pending — and
/// a caller that took the transaction while dropping the state would build its next transfer from the
/// same coins.
#[allow(clippy::too_many_arguments)]
pub fn build_transfer_json(
    state: &[u8],
    zswap_role_key: &[u8; 32],
    recipient_coin_public_key: &[u8; 32],
    recipient_encryption_public_key: &[u8],
    color: &[u8; 32],
    value_le: &[u8; 16],
    network_id: &str,
    ttl_secs: u64,
    artifact_dir: &str,
    params_dir: &str,
) -> Result<String, String> {
    let (tx, next) = build_transfer_tx(TransferRequest {
        state,
        zswap_role_key,
        recipient_coin_public_key: *recipient_coin_public_key,
        recipient_encryption_public_key,
        color: *color,
        value: u128::from_le_bytes(*value_le),
        network_id,
        ttl_secs,
        artifact_dir,
        params_dir,
    })?;
    Ok(format!(
        "{{\"tx\":\"{}\",\"state\":\"{}\"}}",
        hex(&tx),
        hex(&next)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use bip32::{DerivationPath, XPrv};
    use bip39::Mnemonic;

    /// Coin public key of the canonical test mnemonic's shielded address — the first 32 bytes the
    /// `mn_shield-addr` golden vector in `crate::tests` and `midnight.test.ts` encode.
    const COIN_PK: &str = "978a97379c30c21bb7cc8a7e0e247a87e00e623fe8a86c31ec9a92b54435b699";

    /// The role-3 (Zswap) key, derived rather than pasted so these tests are pinned to the same
    /// wallet the app derives instead of to bytes that merely exercise the state machine.
    ///
    /// Role 3 is Zswap and role 2 is Dust. The published SDK guide said Dust was 4 until
    /// `midnightntwrk/midnight-docs#1248`, and a wallet built on that would look healthy while its
    /// DUST sat at an address it could not spend from.
    fn zswap_role_key() -> [u8; 32] {
        let seed = Mnemonic::parse("test test test test test test test test test test test junk")
            .unwrap()
            .to_seed("");
        let path: DerivationPath = "m/44'/2400'/0'/3/0".parse().unwrap();
        XPrv::derive_from_path(&seed, &path)
            .unwrap()
            .private_key()
            .to_bytes()
            .into()
    }

    fn coin(value: u128, color: u8) -> Coin {
        Coin {
            nonce: [7u8; 32],
            color: [color; 32],
            value,
        }
    }

    #[test]
    fn the_state_is_keyed_to_the_wallet_the_app_derives() {
        // Ties this module to the address the app publishes: a coin inserted below is one the app's
        // own `mn_shield-addr` would receive, so a wrong role or a wrong seed fails here rather than
        // producing a self-consistent wallet nobody can pay.
        assert_eq!(
            hex(&keys_from(&zswap_role_key()).coin_public_key().0 .0),
            COIN_PK
        );
    }

    #[test]
    fn a_fresh_state_round_trips_and_holds_nothing() {
        let bytes = state_new().expect("new state");
        let summary = state_summary_json(&bytes).expect("summary");
        assert_eq!(
            summary,
            "{\"firstFree\":0,\"pending\":0,\"balances\":[],\"coins\":[]}"
        );
    }

    #[test]
    fn an_inserted_coin_is_spendable_state_with_a_merkle_index() {
        let state = state_new().expect("new state");
        let state =
            state_insert_coin(&state, &zswap_role_key(), &coin(1_000, 0xaa)).expect("insert");
        let summary = state_summary_json(&state).expect("summary");

        // first_free advanced, so the coin occupies index 0 and the next lands at 1.
        assert!(summary.contains("\"firstFree\":1"), "{summary}");
        assert!(summary.contains("\"mtIndex\":0"), "{summary}");
        assert!(summary.contains("\"value\":\"1000\""), "{summary}");
        assert!(
            summary.contains(&format!("\"color\":\"{}\"", hex(&[0xaa; 32]))),
            "{summary}"
        );
    }

    #[test]
    fn balances_sum_per_colour_and_keep_colours_apart() {
        let mut state = state_new().expect("new state");
        for (value, color) in [(300u128, 0xaa), (700, 0xaa), (5, 0xbb)] {
            // A distinct nonce per coin: reusing one produces the same commitment, which the ledger
            // rejects as a duplicate — so the wallet must not manufacture one either.
            let mut c = coin(value, color);
            c.nonce[0] = value as u8;
            state = state_insert_coin(&state, &zswap_role_key(), &c).expect("insert");
        }
        let summary = state_summary_json(&state).expect("summary");
        assert!(
            summary.contains("\"value\":\"1000\""),
            "0xaa should total 1000: {summary}"
        );
        assert!(
            summary.contains("\"value\":\"5\""),
            "0xbb should stay 5: {summary}"
        );
        assert!(summary.contains("\"firstFree\":3"), "{summary}");
    }

    #[test]
    fn a_watched_coin_is_not_yet_a_balance() {
        let state = state_new().expect("new state");
        let watched = state_watch_for(&state, &zswap_role_key(), &coin(42, 0xcc)).expect("watch");
        let summary = state_summary_json(&watched).expect("summary");
        // Pending, so it must not be spendable or counted: the coin exists in someone's plan, not on
        // the ledger. Counting it would show a balance that cannot be sent.
        assert_eq!(
            summary,
            "{\"firstFree\":0,\"pending\":0,\"balances\":[],\"coins\":[]}"
        );
    }

    #[test]
    fn a_u128_value_survives_the_boundary_as_a_string() {
        let state = state_new().expect("new state");
        let big = u128::MAX - 1;
        let state = state_insert_coin(&state, &zswap_role_key(), &coin(big, 0xdd)).expect("insert");
        let summary = state_summary_json(&state).expect("summary");
        assert!(
            summary.contains(&format!("\"value\":\"{big}\"")),
            "{summary}"
        );
    }

    #[test]
    fn a_malformed_state_is_rejected_rather_than_read_as_empty() {
        let err = state_summary_json(&[0u8; 8]).expect_err("garbage must not decode");
        assert!(err.contains("deserialize wallet state"), "{err}");
    }

    #[test]
    fn a_malformed_collapsed_update_is_rejected() {
        let state = state_new().expect("new state");
        let err =
            state_apply_collapsed_update(&state, &[0u8; 8]).expect_err("garbage must not apply");
        assert!(err.contains("deserialize collapsed update"), "{err}");
    }

    fn coin_wire(value: u128, color: u8) -> Vec<u8> {
        let mut wire = Vec::with_capacity(COIN_WIRE_LEN);
        wire.extend_from_slice(&[7u8; 32]);
        wire.extend_from_slice(&[color; 32]);
        wire.extend_from_slice(&value.to_le_bytes());
        wire
    }

    #[test]
    fn the_op_seam_carries_a_coin_through_unchanged() {
        let key = zswap_role_key();
        let state = state_op("new", &[], &key, &[]).expect("new");
        let state = state_op("insertCoin", &state, &key, &coin_wire(2_500, 0xee)).expect("insert");
        let summary = read_op("summary", &state, &key, &[]).expect("summary");
        assert!(summary.contains("\"value\":\"2500\""), "{summary}");
        assert!(summary.contains("\"mtIndex\":0"), "{summary}");
    }

    #[test]
    fn an_unknown_op_fails_rather_than_returning_the_state_untouched() {
        let key = zswap_role_key();
        let state = state_op("new", &[], &key, &[]).expect("new");
        let err = state_op("aplyCollapsedUpdate", &state, &key, &[]).expect_err("typo must fail");
        assert!(err.contains("unknown wallet state op"), "{err}");
        let err = read_op("balance", &state, &key, &[]).expect_err("wrong name must fail");
        assert!(err.contains("unknown wallet read op"), "{err}");
    }

    #[test]
    fn a_short_coin_is_a_decode_error_not_a_zero_padded_coin() {
        let key = zswap_role_key();
        let state = state_op("new", &[], &key, &[]).expect("new");
        let err = state_op("insertCoin", &state, &key, &[0u8; 64]).expect_err("64 bytes must fail");
        assert!(err.contains("coin must be 80 bytes"), "{err}");
    }

    #[test]
    fn applying_an_offer_that_pays_us_claims_the_coin_from_its_ciphertext() {
        use midnight_zswap::{Delta, Offer, Output};
        use rand::rngs::OsRng;

        let key = zswap_role_key();
        let keys = keys_from(&key);
        let paid = CoinInfo {
            nonce: Nonce(HashOutput([9u8; 32])),
            type_: ShieldedTokenType(HashOutput([0xab; 32])),
            value: 4_200,
        };
        // An output addressed to our coin public key *with* an encryption key, i.e. an ordinary
        // wallet-to-wallet payment. This is the case a contract mint cannot produce, which is why
        // `insertCoin` exists beside it.
        let output = Output::new(
            &mut OsRng,
            &paid,
            Some(0),
            &keys.coin_public_key(),
            Some(keys.enc_public_key()),
        )
        .expect("build output");
        let offer = Offer {
            inputs: vec![].into(),
            outputs: vec![output].into(),
            transient: vec![].into(),
            deltas: vec![Delta {
                token_type: paid.type_,
                value: -(paid.value as i128),
            }]
            .into(),
        };

        let state = decode(&state_new().expect("new")).expect("decode");
        let applied = state.apply(&keys, &offer).expect("apply");
        let summary = state_summary_json(&encode(&applied).expect("encode")).expect("summary");

        // Discovered purely from the ciphertext: nothing told the wallet this coin existed.
        assert!(summary.contains("\"value\":\"4200\""), "{summary}");
        assert!(summary.contains("\"mtIndex\":0"), "{summary}");
        assert!(summary.contains("\"firstFree\":1"), "{summary}");
    }

    #[test]
    fn an_offer_paying_someone_else_advances_the_tree_and_claims_nothing() {
        use midnight_zswap::keys::Seed as ZswapSeed;
        use midnight_zswap::{Delta, Offer, Output};
        use rand::rngs::OsRng;

        let keys = keys_from(&zswap_role_key());
        let stranger = SecretKeys::from(ZswapSeed::from([0x33u8; 32]));
        let paid = CoinInfo {
            nonce: Nonce(HashOutput([1u8; 32])),
            type_: ShieldedTokenType(HashOutput([0xab; 32])),
            value: 99,
        };
        let output = Output::new(
            &mut OsRng,
            &paid,
            Some(0),
            &stranger.coin_public_key(),
            Some(stranger.enc_public_key()),
        )
        .expect("build output");
        let offer = Offer {
            inputs: vec![].into(),
            outputs: vec![output].into(),
            transient: vec![].into(),
            deltas: vec![Delta {
                token_type: paid.type_,
                value: -(paid.value as i128),
            }]
            .into(),
        };

        let state = decode(&state_new().expect("new")).expect("decode");
        let applied = state.apply(&keys, &offer).expect("apply");
        let summary = state_summary_json(&encode(&applied).expect("encode")).expect("summary");

        // The cursor still moves: index order *is* the tree, so skipping a stranger's output would
        // put every later coin of ours at the wrong index and its proofs would not verify.
        assert!(summary.contains("\"firstFree\":1"), "{summary}");
        assert!(
            summary.contains("\"coins\":[]"),
            "must not claim a stranger's coin: {summary}"
        );
    }

    #[test]
    fn a_malformed_transaction_is_rejected() {
        let state = state_new().expect("new");
        let err = state_apply_transaction(&state, &zswap_role_key(), &[0u8; 8], Some(&[]))
            .expect_err("garbage");
        assert!(err.contains("deserialize transaction"), "{err}");
    }

    #[test]
    fn the_segment_list_must_be_well_formed_rather_than_assumed() {
        let key = zswap_role_key();
        let state = state_op("new", &[], &key, &[]).expect("new");
        // A count that overruns the buffer: silently treating the remainder as the transaction would
        // apply *some* transaction, which is worse than refusing.
        let err = state_op("applyTransaction", &state, &key, &[9, 0, 1, 2]).expect_err("bad count");
        assert!(err.contains("declares 9 segments"), "{err}");
        let err = state_op("applyTransaction", &state, &key, &[1]).expect_err("no count");
        assert!(err.contains("2-byte segment count"), "{err}");
        // The all-sections sentinel still has to carry a transaction.
        let err = state_op("applyTransaction", &state, &key, &[0xff, 0xff]).expect_err("no tx");
        assert!(err.contains("deserialize transaction"), "{err}");
    }

    #[test]
    fn a_foreign_ciphertext_reads_as_not_ours_only_when_it_parses() {
        let key = zswap_role_key();
        // Garbage is a decode failure, not "not ours" — the two must stay distinguishable, or a
        // corrupt stream would look like a chain with no coins for us on it.
        let err = read_op("tryDecrypt", &[], &key, &[0u8; 16]).expect_err("garbage must fail");
        assert!(err.contains("deserialize coin ciphertext"), "{err}");
    }

    /// A `signData` signature must actually verify under the reported key, over the exact bytes given.
    ///
    /// This is the only assertion that matters: widths and hex are shape, but a signature that does not
    /// verify is a wallet handing a dApp a proof of nothing.
    #[test]
    fn a_signature_verifies_under_the_key_it_reports() {
        use midnight_base_crypto::signatures::{Signature, VerifyingKey};
        use midnight_serialize::Deserializable;

        let key = night_role_key_for_signing();
        let message = b"pnyx connector signData test";

        let json = read_op("signData", &[], &key, message).expect("signData");
        let sig_hex = between(&json, "\"signature\":\"", "\"");
        let vk_hex = between(&json, "\"verifyingKey\":\"", "\"");

        assert_eq!(sig_hex.len(), 128, "a signature is 64 bytes (r || s)");
        assert_eq!(
            vk_hex.len(),
            64,
            "a verifying key is 32 bytes (BIP-340 x-only)"
        );

        let sig_bytes = unhex(sig_hex);
        let vk_bytes = unhex(vk_hex);
        let signature: Signature =
            Deserializable::deserialize(&mut &sig_bytes[..], 0).expect("signature deserializes");
        let verifying_key: VerifyingKey =
            Deserializable::deserialize(&mut &vk_bytes[..], 0).expect("verifying key deserializes");

        assert!(
            verifying_key.verify(message, &signature),
            "the signature must verify over the message"
        );
        assert!(
            !verifying_key.verify(b"a different message", &signature),
            "and must not verify over anything else"
        );
    }

    /// The reported key is the one the Night role key owns — not a fresh one.
    ///
    /// A signature that verifies under a key nobody can tie to this wallet proves nothing about it.
    #[test]
    fn the_reported_key_belongs_to_the_night_role_key() {
        use midnight_base_crypto::signatures::SigningKey;
        use midnight_serialize::Serializable;

        let key = night_role_key_for_signing();
        let json = read_op("signData", &[], &key, b"x").expect("signData");

        let mut expected = Vec::new();
        Serializable::serialize(
            &SigningKey::from_bytes(&key).expect("key").verifying_key(),
            &mut expected,
        )
        .expect("serialize");

        assert_eq!(between(&json, "\"verifyingKey\":\"", "\""), hex(&expected));
    }

    /// ⚠️ Signing is randomised (`sign_with_rng`), so two signatures over one message differ.
    ///
    /// Pinned as a property rather than left to surprise a caller who caches or dedupes on a signature.
    #[test]
    fn signing_the_same_message_twice_gives_different_signatures() {
        let key = night_role_key_for_signing();

        let first = read_op("signData", &[], &key, b"same message").expect("first");
        let second = read_op("signData", &[], &key, b"same message").expect("second");

        assert_ne!(
            between(&first, "\"signature\":\"", "\""),
            between(&second, "\"signature\":\"", "\""),
            "BIP-340 signing here is randomised"
        );
        assert_eq!(
            between(&first, "\"verifyingKey\":\"", "\""),
            between(&second, "\"verifyingKey\":\"", "\""),
            "but the key does not move"
        );
    }

    /// Signing the empty message is a valid request, not an error to guess about.
    #[test]
    fn the_empty_message_is_signable() {
        let json = read_op("signData", &[], &night_role_key_for_signing(), &[]).expect("signData");

        assert_eq!(between(&json, "\"signature\":\"", "\"").len(), 128);
    }

    /// A key the curve rejects must fail, not sign under something else.
    #[test]
    fn a_malformed_role_key_is_refused() {
        let error =
            read_op("signData", &[], &[0u8; 32], b"x").expect_err("a zero scalar is not a key");

        assert!(
            error.contains("night role key"),
            "the reason must name the key: {error}"
        );
    }

    /// Role 0 (Night) derived from the pinned test mnemonic — the key an unshielded address names.
    fn night_role_key_for_signing() -> [u8; 32] {
        use bip32::{DerivationPath, XPrv};
        use bip39::Mnemonic;
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

    fn unhex(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn between<'a>(haystack: &'a str, start: &str, end: &str) -> &'a str {
        let from = haystack.find(start).expect("start marker") + start.len();
        let rest = &haystack[from..];
        &rest[..rest.find(end).expect("end marker")]
    }
}
