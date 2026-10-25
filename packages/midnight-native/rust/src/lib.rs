//! Native Midnight key derivation — the curve math behind Midnight receive addresses,
//! wrapping Midnight's own published crates (no WASM).
//!
//! HD derivation (`m/44'/2400'/account'/role/index`, secp256k1) is done host-side in JS
//! (`@midnight-ntwrk/wallet-sdk-hd`, pure/Hermes-safe); this module takes a derived role secret
//! key and returns the raw address payload. bech32m/SCALE encoding is also done host-side
//! (`packages/wallet/account/derivation/midnight-address-encoding.ts`).
//!
//! Three ops, mapping 1:1 to the JS `MidnightCurveBackend`:
//! - night:    role-0 key → 32-byte payload (SHA-256 of the BIP340 verifying key)
//! - dust:     role-2 key → 32-byte BLS12-381 scalar, little-endian
//! - shielded: role-3 key → 64 bytes = coin_public_key(32) ‖ encryption_public_key(32)

/// The C ABI (iOS) exposes the proving surface, so it follows the same feature.
#[cfg(feature = "proving")]
pub mod c_bridge;
#[cfg(feature = "proving")]
pub mod circle;

/// Domain-separated derivations shared by the circuits and by the readers over their state. Ungated:
/// a state reader needs them and `preimage` is behind `proving`, which is what broke the Worker build.
pub mod derivations;

/// Funding a transaction a dApp composed — reads the ledger's own balance map and covers what it owes.
#[cfg(feature = "proving")]
pub mod balance;
/// The one circle read a **decode-only** host can do: which circle a contract was sealed to.
///
/// Split from `circle` because that module's member paths need `midnight-transient-crypto`'s Merkle
/// hashing, which the Worker build deliberately does not link — a tree read would drag the whole
/// transient-crypto tree in for one question. Reading a sealed cell needs none of it.
pub mod circle_read;
/// The Compact host bridge — serves the WASM leaves the compactc-generated JS driver needs, so the
/// driver itself can run on Hermes. Gated with the proving feature: it links the same VM, hashing
/// and Merkle crates the preimage builders do.
#[cfg(feature = "proving")]
pub mod compact;
#[cfg(feature = "proving")]
pub mod cofunded;
#[cfg(feature = "proving")]
pub mod deploy;
/// Panic-to-logcat and memory notes. Not feature-gated: a decode-only build can panic too, and
/// on Android nothing else would show it.
pub mod diag;
/// DUST on the device: the state a phone needs to pay its own Midnight fee.
#[cfg(feature = "proving")]
pub mod dust;
/// What a transaction contains, read from the transaction — the device half of the review-from-bytes
/// work (`docs/MIDNIGHT_REVIEW_FROM_BYTES.md`).
#[cfg(feature = "proving")]
pub mod facts;
/// Paying any unbound transaction's DUST fee from this wallet, whoever built it.
#[cfg(feature = "proving")]
pub mod fee;
pub mod identity;
#[cfg(all(target_os = "android", feature = "proving"))]
mod jni_bridge;
#[cfg(feature = "proving")]
pub mod preimage;
#[cfg(feature = "proving")]
pub mod prove;
pub mod shielded_call;
pub mod state_read;
#[cfg(feature = "proving")]
pub mod tx;
/// Unshielded transfers. Needs no circuit and no artifacts, but reaches the same ledger tree.
#[cfg(feature = "proving")]
pub mod unshielded;
/// Shielded wallet state. Reaches zswap/coin-structure, so it belongs to `proving` like key
/// derivation does — a decode-only build has no wallet.
#[cfg(feature = "proving")]
pub mod wallet;
/// Worker exports. Behind `worker` rather than `target_arch` so a wasm build *with* proving does
/// not silently inherit the refuse-randomness handler the prover would need.
#[cfg(feature = "worker")]
pub mod wasm_bridge;

/// Reads over the payment contract — what a name costs, and in what currency.
pub mod payment;

/// Reads over a handle contract — who holds a name, and whether it still counts.
pub mod handle;

// Key derivation reaches the ledger/zswap/coin-structure trees, so it belongs to `proving` too:
// a decode-only build has no keys to derive.
#[cfg(feature = "proving")]
use midnight_base_crypto::signatures::SigningKey;
#[cfg(feature = "proving")]
use midnight_coin_structure::coin::UserAddress;
#[cfg(feature = "proving")]
use midnight_ledger::dust::{DustPublicKey, DustSecretKey};
#[cfg(feature = "proving")]
use midnight_serialize::Serializable;
#[cfg(feature = "proving")]
use midnight_zswap::keys::{SecretKeys, Seed};

#[cfg(feature = "proving")]
const OK: i32 = 0;
#[cfg(feature = "proving")]
const ERR_NULL: i32 = 1;
#[cfg(feature = "proving")]
const ERR_NIGHT_KEY: i32 = 2;
#[cfg(feature = "proving")]
const ERR_SERIALIZE: i32 = 3;
#[cfg(feature = "proving")]
const ERR_PROVE: i32 = 4;

#[cfg(feature = "proving")]
/// Night: role-0 secp256k1 key → BIP340 verifying key → SHA-256 `UserAddress` (32 bytes).
pub fn night_payload(night_role_key: &[u8; 32]) -> Result<[u8; 32], i32> {
    let signing_key = SigningKey::from_bytes(night_role_key).map_err(|_| ERR_NIGHT_KEY)?;
    Ok(UserAddress::from(signing_key.verifying_key()).0 .0)
}

#[cfg(feature = "proving")]
/// DUST: role-2 key → `DustPublicKey` (BLS12-381 Fr), little-endian (32 bytes).
pub fn dust_public_key_le(dust_role_key: &[u8; 32]) -> [u8; 32] {
    let pk = DustPublicKey::from(DustSecretKey::derive_secret_key(dust_role_key));
    let mut le = pk.0 .0.to_bytes_be();
    le.reverse();
    let mut out = [0u8; 32];
    out.copy_from_slice(&le);
    out
}

#[cfg(feature = "proving")]
/// Shielded: role-3 key → coin_public_key(32) ‖ encryption_public_key(32).
pub fn shielded_public_keys(zswap_role_key: &[u8; 32]) -> Result<[u8; 64], i32> {
    let keys = SecretKeys::from(Seed::from(*zswap_role_key));
    let mut out = [0u8; 64];
    out[0..32].copy_from_slice(&keys.coin_public_key().0 .0);
    let mut enc = Vec::new();
    Serializable::serialize(&keys.enc_public_key(), &mut enc).map_err(|_| ERR_SERIALIZE)?;
    if enc.len() != 32 {
        return Err(ERR_SERIALIZE);
    }
    out[32..64].copy_from_slice(&enc);
    Ok(out)
}

#[cfg(feature = "proving")]
/// # Safety
/// `night_role_key` points to 32 readable bytes; `out` points to 32 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn midnight_night_payload(night_role_key: *const u8, out: *mut u8) -> i32 {
    if night_role_key.is_null() || out.is_null() {
        return ERR_NULL;
    }
    match night_payload(&*(night_role_key as *const [u8; 32])) {
        Ok(p) => {
            std::ptr::copy_nonoverlapping(p.as_ptr(), out, 32);
            OK
        }
        Err(code) => code,
    }
}

#[cfg(feature = "proving")]
/// # Safety
/// `dust_role_key` points to 32 readable bytes; `out` points to 32 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn midnight_dust_public_key(dust_role_key: *const u8, out: *mut u8) -> i32 {
    if dust_role_key.is_null() || out.is_null() {
        return ERR_NULL;
    }
    let p = dust_public_key_le(&*(dust_role_key as *const [u8; 32]));
    std::ptr::copy_nonoverlapping(p.as_ptr(), out, 32);
    OK
}

#[cfg(feature = "proving")]
/// # Safety
/// `zswap_role_key` points to 32 readable bytes; `out` points to 64 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn midnight_shielded_public_keys(
    zswap_role_key: *const u8,
    out: *mut u8,
) -> i32 {
    if zswap_role_key.is_null() || out.is_null() {
        return ERR_NULL;
    }
    match shielded_public_keys(&*(zswap_role_key as *const [u8; 32])) {
        Ok(p) => {
            std::ptr::copy_nonoverlapping(p.as_ptr(), out, 64);
            OK
        }
        Err(code) => code,
    }
}

#[cfg(feature = "proving")]
/// Prove one compiled circuit invocation (see `prove::prove_circuit` for the byte formats).
/// On success writes a malloc'd buffer holding the tagged-serialized proof to `out_proof` /
/// `out_proof_len`; the caller releases it with `midnight_buffer_free`.
///
/// # Safety
/// Each `(ptr, len)` pair points to `len` readable bytes; `out_proof` and `out_proof_len`
/// are writable. The returned buffer must be freed exactly once via `midnight_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn midnight_prove_circuit(
    zkir: *const u8,
    zkir_len: usize,
    prover_key: *const u8,
    prover_key_len: usize,
    verifier_key: *const u8,
    verifier_key_len: usize,
    params: *const u8,
    params_len: usize,
    preimage: *const u8,
    preimage_len: usize,
    out_proof: *mut *mut u8,
    out_proof_len: *mut usize,
) -> i32 {
    if zkir.is_null()
        || prover_key.is_null()
        || verifier_key.is_null()
        || params.is_null()
        || preimage.is_null()
        || out_proof.is_null()
        || out_proof_len.is_null()
    {
        return ERR_NULL;
    }
    let result = prove::prove_circuit(
        std::slice::from_raw_parts(zkir, zkir_len),
        std::slice::from_raw_parts(prover_key, prover_key_len),
        std::slice::from_raw_parts(verifier_key, verifier_key_len),
        std::slice::from_raw_parts(params, params_len),
        std::slice::from_raw_parts(preimage, preimage_len),
    );
    match result {
        Ok(output) => {
            let boxed = output.proof.into_boxed_slice();
            *out_proof_len = boxed.len();
            *out_proof = Box::into_raw(boxed) as *mut u8;
            OK
        }
        Err(_) => ERR_PROVE,
    }
}

#[cfg(feature = "proving")]
/// # Safety
/// `ptr`/`len` must come from a single `midnight_prove_circuit` success and be freed once.
#[no_mangle]
pub unsafe extern "C" fn midnight_buffer_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}

#[cfg(all(test, feature = "proving"))]
mod tests {
    use super::*;
    use bip32::{DerivationPath, XPrv};
    use bip39::Mnemonic;

    const MNEMONIC: &str = "test test test test test test test test test test test junk";
    const NIGHT: &str = "fdf6ad91b11bb3af29308de0e54f055d5ccb5d705f920f524bfdfdaf57b11e41";
    const DUST_LE: &str = "6cde37b99ede2ca54f1b113ee361d8c0429a5299c0f1caf19680a98f208c8866";
    const COIN: &str = "978a97379c30c21bb7cc8a7e0e247a87e00e623fe8a86c31ec9a92b54435b699";
    const ENC: &str = "365e2c24716918bfc917051311df6ca8c39990abe9668db9674c144987503dbd";

    fn role_key(seed: &[u8], role: u32) -> [u8; 32] {
        let path: DerivationPath = format!("m/44'/2400'/0'/{role}/0").parse().unwrap();
        XPrv::derive_from_path(seed, &path)
            .unwrap()
            .private_key()
            .to_bytes()
            .into()
    }

    #[test]
    fn derives_golden_vectors() {
        let seed = Mnemonic::parse(MNEMONIC).unwrap().to_seed("");
        assert_eq!(
            hex::encode(night_payload(&role_key(&seed, 0)).unwrap()),
            NIGHT,
            "night"
        );
        assert_eq!(
            hex::encode(dust_public_key_le(&role_key(&seed, 2))),
            DUST_LE,
            "dust"
        );
        let shielded = shielded_public_keys(&role_key(&seed, 3)).unwrap();
        assert_eq!(hex::encode(&shielded[0..32]), COIN, "coin");
        assert_eq!(hex::encode(&shielded[32..64]), ENC, "enc");
    }
}
