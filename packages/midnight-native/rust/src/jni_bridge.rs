//! JNI exports for Android — let a Kotlin `external fun` bind directly (no manual RegisterNatives).
//! Symbol names match `expo.modules.midnightnative.MidnightNativeModule`. The iOS path uses the
//! C ABI in `lib.rs` instead; this module is Android-only.

use crate::balance as balance_mod;
use crate::circle as circle_mod;
use crate::cofunded as cofunded_mod;
use crate::fee as fee_mod;
use crate::identity as identity_mod;
use crate::preimage::build_join_proven_tx;
use crate::prove::{check_preimage, circuit_k, prove_circuit, prove_circuit_binding};
use crate::unshielded as unshielded_mod;
use crate::wallet as wallet_mod;
use crate::{dust_public_key_le, night_payload, shielded_public_keys};
use jni::objects::{JByteArray, JClass, JIntArray, JString};
use jni::sys::{jboolean, jbyteArray, jint, jlong, jstring};
use jni::JNIEnv;

/// Runs when Kotlin's `System.loadLibrary("midnight_native")` maps the library, which is the only
/// reason this crate defines it: the panic hook must be in place before any export can run.
#[no_mangle]
pub extern "system" fn JNI_OnLoad(
    _vm: *mut std::ffi::c_void,
    _reserved: *mut std::ffi::c_void,
) -> jint {
    crate::diag::install();
    jni::sys::JNI_VERSION_1_6
}

fn role_key(env: &JNIEnv, arr: &JByteArray) -> Result<[u8; 32], String> {
    let v = env.convert_byte_array(arr).map_err(|e| e.to_string())?;
    v.try_into()
        .map_err(|_| "role key must be 32 bytes".to_string())
}

/// A `Field` argument: 32 little-endian bytes, refused rather than reduced if not canonical — a
/// silently reduced members root would derive a different proposal address.
fn fr_arg(env: &JNIEnv, arr: &JByteArray) -> Result<midnight_transient_crypto::curve::Fr, String> {
    let bytes = bytes32_arg(env, arr, "members root")?;
    midnight_transient_crypto::curve::Fr::from_le_bytes(&bytes)
        .ok_or_else(|| "members root is not a canonical field element".to_string())
}

fn bytes32_arg(env: &JNIEnv, arr: &JByteArray, what: &str) -> Result<[u8; 32], String> {
    let v = env.convert_byte_array(arr).map_err(|e| e.to_string())?;
    v.try_into().map_err(|_| format!("{what} must be 32 bytes"))
}

/// A `byte[]?` argument: Kotlin's `null` becomes `None`, anything else must still be 32 bytes.
///
/// Only `join`'s invite secret uses this, and there absence is meaningful rather than missing — an
/// open circle has no invite, which is a different thing from a caller forgetting to pass one.
fn optional_bytes32_arg(env: &JNIEnv, arr: &JByteArray, what: &str) -> Result<Option<[u8; 32]>, String> {
    if arr.is_null() {
        return Ok(None);
    }
    bytes32_arg(env, arr, what).map(Some)
}

/// The four static proving artifacts (zkir, prover key, verifier key, KZG SRS) as bytes, read from
/// their on-device file paths — the shared prefix of every proven-tx builder.
fn read_artifacts(
    env: &mut JNIEnv,
    zkir_path: &JString,
    prover_key_path: &JString,
    verifier_key_path: &JString,
    params_path: &JString,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>), String> {
    Ok((
        read_file_arg(env, zkir_path, "zkir")?,
        read_file_arg(env, prover_key_path, "prover key")?,
        read_file_arg(env, verifier_key_path, "verifier key")?,
        read_file_arg(env, params_path, "KZG params")?,
    ))
}

fn return_bytes(env: &mut JNIEnv, result: Result<Vec<u8>, String>) -> jbyteArray {
    match result {
        Ok(bytes) => env
            .byte_array_from_slice(&bytes)
            .map(|a| a.into_raw())
            .unwrap_or(std::ptr::null_mut()),
        Err(message) => {
            let _ = env.throw_new("java/lang/RuntimeException", message);
            std::ptr::null_mut()
        }
    }
}

/// Shielded wallet state: every op that returns a new state (`new`, `applyCollapsedUpdate`,
/// `insertCoin`, `watchFor`). One export per return shape rather than per op — see
/// [`crate::wallet::state_op`] for why.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_walletStateOp<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    op: JString<'local>,
    state: JByteArray<'local>,
    zswap_role_key: JByteArray<'local>,
    arg: JByteArray<'local>,
) -> jbyteArray {
    let result = (|| {
        let op: String = env.get_string(&op).map_err(|e| e.to_string())?.into();
        let state = env.convert_byte_array(&state).map_err(|e| e.to_string())?;
        let key = role_key(&env, &zswap_role_key)?;
        let arg = env.convert_byte_array(&arg).map_err(|e| e.to_string())?;
        wallet_mod::state_op(&op, &state, &key, &arg)
    })();
    return_bytes(&mut env, result)
}

/// Build + prove a shielded transfer. Returns JSON `{"tx","state"}` — the transaction to submit and
/// the state with its spends pending. CPU-bound seconds (three circuits), so call it off the JS thread.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_walletBuildTransfer<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    state: JByteArray<'local>,
    zswap_role_key: JByteArray<'local>,
    recipient_coin_public_key: JByteArray<'local>,
    recipient_encryption_public_key: JByteArray<'local>,
    color: JByteArray<'local>,
    value_le: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
    artifact_dir: JString<'local>,
    params_dir: JString<'local>,
) -> jstring {
    let result = (|| {
        let state = env.convert_byte_array(&state).map_err(|e| e.to_string())?;
        let key = role_key(&env, &zswap_role_key)?;
        let recipient_cpk = bytes32_arg(
            &env,
            &recipient_coin_public_key,
            "recipient coin public key",
        )?;
        let recipient_epk = env
            .convert_byte_array(&recipient_encryption_public_key)
            .map_err(|e| e.to_string())?;
        let color = bytes32_arg(&env, &color, "token colour")?;
        let value = env
            .convert_byte_array(&value_le)
            .map_err(|e| e.to_string())?;
        let value: [u8; 16] = value
            .try_into()
            .map_err(|_| "value must be 16 bytes (u128, little-endian)".to_string())?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        let artifacts: String = env
            .get_string(&artifact_dir)
            .map_err(|e| e.to_string())?
            .into();
        let params: String = env
            .get_string(&params_dir)
            .map_err(|e| e.to_string())?
            .into();
        wallet_mod::build_transfer_json(
            &state,
            &key,
            &recipient_cpk,
            &recipient_epk,
            &color,
            &value,
            &network,
            ttl_secs as u64,
            &artifacts,
            &params,
        )
    })();
    return_string(&mut env, result)
}

/// Build + sign an unshielded transfer. Returns the proven, unbound transaction as hex.
///
/// No artifacts and no proving — a transfer has no circuit — so this is milliseconds, unlike
/// `walletBuildTransfer`. It stays an `AsyncFunction` on the Kotlin side anyway: it signs, and the
/// keystore read that hands us the role key is already async at the call site.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_walletBuildUnshieldedTransfer<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    night_role_key: JByteArray<'local>,
    packed_inputs: JByteArray<'local>,
    recipient_address: JByteArray<'local>,
    token_type: JByteArray<'local>,
    value_le: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
    change_chunks: jint,
) -> jstring {
    let result = (|| {
        let key = role_key(&env, &night_role_key)?;
        let inputs = env
            .convert_byte_array(&packed_inputs)
            .map_err(|e| e.to_string())?;
        let recipient = bytes32_arg(&env, &recipient_address, "recipient address")?;
        let token = bytes32_arg(&env, &token_type, "token type")?;
        let value = env
            .convert_byte_array(&value_le)
            .map_err(|e| e.to_string())?;
        let value: [u8; 16] = value
            .try_into()
            .map_err(|_| "value must be 16 bytes (u128, little-endian)".to_string())?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        unshielded_mod::build_unshielded_transfer_hex(
            &key,
            &inputs,
            &recipient,
            &token,
            &value,
            &network,
            ttl_secs as u64,
            change_chunks.max(0) as u32,
        )
    })();
    return_string(&mut env, result)
}

/// Build a transfer that pays its own DUST fee. Returns JSON `{"tx","state","fee"}`.
///
/// Unlike `walletBuildUnshieldedTransfer` this **proves** (the K=13 dust spend circuit) and **seals**,
/// so it takes artifact paths and costs real CPU — an `AsyncFunction`, not a `Function`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_walletBuildSelfFundedTransfer<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    night_role_key: JByteArray<'local>,
    packed_inputs: JByteArray<'local>,
    recipient_address: JByteArray<'local>,
    token_type: JByteArray<'local>,
    value_le: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
    dust_state: JByteArray<'local>,
    dust_role_key: JByteArray<'local>,
    ctime_secs: jlong,
    artifact_dir: JString<'local>,
    params_dir: JString<'local>,
    fee_margin: jint,
    change_chunks: jint,
) -> jstring {
    let result = (|| {
        let key = role_key(&env, &night_role_key)?;
        let inputs = env
            .convert_byte_array(&packed_inputs)
            .map_err(|e| e.to_string())?;
        let recipient = bytes32_arg(&env, &recipient_address, "recipient address")?;
        let token = bytes32_arg(&env, &token_type, "token type")?;
        let value = env
            .convert_byte_array(&value_le)
            .map_err(|e| e.to_string())?;
        let value: [u8; 16] = value
            .try_into()
            .map_err(|_| "value must be 16 bytes (u128, little-endian)".to_string())?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        let dust = env
            .convert_byte_array(&dust_state)
            .map_err(|e| e.to_string())?;
        let dust_key = role_key(&env, &dust_role_key)?;
        let artifacts: String = env
            .get_string(&artifact_dir)
            .map_err(|e| e.to_string())?
            .into();
        let params: String = env
            .get_string(&params_dir)
            .map_err(|e| e.to_string())?
            .into();
        unshielded_mod::build_self_funded_transfer_hex(
            &key,
            &inputs,
            &recipient,
            &token,
            &value,
            &network,
            ttl_secs as u64,
            &dust,
            &dust_key,
            ctime_secs as u64,
            &artifacts,
            &params,
            fee_margin as usize,
            change_chunks.max(0) as u32,
        )
    })();
    return_string(&mut env, result)
}

/// Pay any unbound transaction's DUST fee from this wallet, whoever built it. Returns JSON
/// `{"tx","state","fee","paid","segment","identifiers"}`.
///
/// Proves the K=13 dust spend circuit, merges and seals, so it takes artifact paths and costs real
/// CPU — an `AsyncFunction`, like `walletBuildSelfFundedTransfer`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_walletPayFeeFromDust<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    transaction: JByteArray<'local>,
    dust_state: JByteArray<'local>,
    dust_role_key: JByteArray<'local>,
    ctime_secs: jlong,
    ttl_secs: jlong,
    artifact_dir: JString<'local>,
    params_dir: JString<'local>,
    fee_margin: jint,
) -> jstring {
    let result = (|| {
        let tx = env
            .convert_byte_array(&transaction)
            .map_err(|e| e.to_string())?;
        let dust = env
            .convert_byte_array(&dust_state)
            .map_err(|e| e.to_string())?;
        let dust_key = role_key(&env, &dust_role_key)?;
        let artifacts: String = env
            .get_string(&artifact_dir)
            .map_err(|e| e.to_string())?
            .into();
        let params: String = env
            .get_string(&params_dir)
            .map_err(|e| e.to_string())?
            .into();
        fee_mod::pay_fee_from_dust_hex(
            &tx,
            &dust,
            &dust_key,
            ctime_secs as u64,
            ttl_secs as u64,
            &artifacts,
            &params,
            fee_margin as usize,
        )
    })();
    return_string(&mut env, result)
}

/// Fund the deficits of a transaction a dApp composed, sign the intents that changed, and return the
/// funded transaction as hex.
///
/// No artifacts and no proving — the transaction arrives proven and only unshielded value is added —
/// so this is milliseconds. It stays an `AsyncFunction` on the Kotlin side because it signs, and the
/// keystore read that hands us the role key is already async at the call site.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_walletBalanceUnsealedTransaction<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    transaction: JByteArray<'local>,
    night_role_key: JByteArray<'local>,
    packed_inputs: JByteArray<'local>,
) -> jstring {
    let result = (|| {
        let tx = env
            .convert_byte_array(&transaction)
            .map_err(|e| e.to_string())?;
        let key = role_key(&env, &night_role_key)?;
        let inputs = env
            .convert_byte_array(&packed_inputs)
            .map_err(|e| e.to_string())?;
        balance_mod::balance_unsealed_transaction_hex(&tx, &key, &inputs)
    })();
    return_string(&mut env, result)
}

/// **Co-funding step 1 — the composer.** Gather every contributor's inputs into one finalised,
/// unsigned intent. Returns the intent as hex; every contributor signs over exactly these bytes.
///
/// See `crate::cofunded` for why the intent must be final before anyone signs.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_walletBuildCoFundedIntent<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    packed_contributions: JByteArray<'local>,
    recipient_address: JByteArray<'local>,
    token_type: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jstring {
    let result = (|| {
        let contributions = env
            .convert_byte_array(&packed_contributions)
            .map_err(|e| e.to_string())?;
        let recipient = bytes32_arg(&env, &recipient_address, "recipient address")?;
        let token = bytes32_arg(&env, &token_type, "token type")?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        cofunded_mod::build_cofunded_intent_hex(
            &contributions,
            &recipient,
            &token,
            &network,
            ttl_secs as u64,
        )
    })();
    return_string(&mut env, result)
}

/// **Co-funding step 2 — a contributor.** Sign only the inputs this key owns.
///
/// Answers `""` when this wallet owns none of them, which is a fact and not a failure.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_walletSignCoFundedShare<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    intent: JByteArray<'local>,
    night_role_key: JByteArray<'local>,
) -> jstring {
    let result = (|| {
        let intent_bytes = env.convert_byte_array(&intent).map_err(|e| e.to_string())?;
        let key = role_key(&env, &night_role_key)?;
        cofunded_mod::sign_cofunded_share_hex(&intent_bytes, &key)
    })();
    return_string(&mut env, result)
}

/// **Co-funding step 3 — the composer.** Place every gathered signature at its input's index, verify
/// the offer here rather than at the node, and prove. Returns the proven unbound transaction as hex.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_walletAssembleCoFundedTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    intent: JByteArray<'local>,
    packed_shares: JByteArray<'local>,
    network_id: JString<'local>,
) -> jstring {
    let result = (|| {
        let intent_bytes = env.convert_byte_array(&intent).map_err(|e| e.to_string())?;
        let shares = env
            .convert_byte_array(&packed_shares)
            .map_err(|e| e.to_string())?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        cofunded_mod::assemble_cofunded_tx_hex(&intent_bytes, &shares, &network)
    })();
    return_string(&mut env, result)
}

/// Shielded wallet reads (`summary`, `tryDecrypt`), as JSON. `tryDecrypt` yields the four bytes
/// `null` for an output that is not ours, which is an answer rather than a failure.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_walletReadOp<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    op: JString<'local>,
    state: JByteArray<'local>,
    zswap_role_key: JByteArray<'local>,
    arg: JByteArray<'local>,
) -> jstring {
    let result = (|| {
        let op: String = env.get_string(&op).map_err(|e| e.to_string())?.into();
        let state = env.convert_byte_array(&state).map_err(|e| e.to_string())?;
        let key = role_key(&env, &zswap_role_key)?;
        let arg = env.convert_byte_array(&arg).map_err(|e| e.to_string())?;
        wallet_mod::read_op(&op, &state, &key, &arg)
    })();
    return_string(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_nightPayload<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    key: JByteArray<'local>,
) -> jbyteArray {
    let result = role_key(&env, &key)
        .and_then(|k| night_payload(&k).map_err(|c| format!("night derive failed (code {c})")))
        .map(|p| p.to_vec());
    return_bytes(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_dustPublicKey<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    key: JByteArray<'local>,
) -> jbyteArray {
    let result = role_key(&env, &key).map(|k| dust_public_key_le(&k).to_vec());
    return_bytes(&mut env, result)
}

/// The `check` half of the connector's proving provider: is this preimage well formed for this
/// circuit, and which public inputs does it skip? JSON array of `number | null`.
///
/// Bytes rather than paths for the ZKIR, because a dApp's circuit is not a cached artifact of ours —
/// it arrives with the request — and a ZKIR is kilobytes where the keys and SRS are megabytes.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_checkPreimage<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir: JByteArray<'local>,
    preimage: JByteArray<'local>,
) -> jstring {
    let result = (|| {
        let zkir = env.convert_byte_array(&zkir).map_err(|e| e.to_string())?;
        let preimage = env
            .convert_byte_array(&preimage)
            .map_err(|e| e.to_string())?;
        let skips = check_preimage(&zkir, &preimage)?;
        let items: Vec<String> = skips
            .iter()
            .map(|s| match s {
                Some(v) => v.to_string(),
                None => "null".to_string(),
            })
            .collect();
        Ok(format!("[{}]", items.join(",")))
    })();
    return_string(&mut env, result)
}

/// [`proveCircuit`], with the caller's binding input replacing the preimage's.
///
/// A separate export rather than a sixth parameter on `proveCircuit`: that one is the rail every
/// existing circuit proves through, and widening its signature would touch all five bridge halves for
/// callers that never pass an override. `binding_le_hex` is empty for "leave the preimage alone".
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_provePreimageWithBinding<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    preimage: JByteArray<'local>,
    binding_le_hex: JString<'local>,
) -> jbyteArray {
    let result = (|| {
        let zkir = read_file_arg(&mut env, &zkir_path, "zkir")?;
        let prover_key = read_file_arg(&mut env, &prover_key_path, "prover key")?;
        let verifier_key = read_file_arg(&mut env, &verifier_key_path, "verifier key")?;
        let params = read_file_arg(&mut env, &params_path, "KZG params")?;
        let preimage = env
            .convert_byte_array(&preimage)
            .map_err(|e| e.to_string())?;
        let binding: String = env
            .get_string(&binding_le_hex)
            .map_err(|e| e.to_string())?
            .into();
        let binding = decode_binding(&binding)?;
        let output = prove_circuit_binding(
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &preimage,
            binding.as_ref(),
        )?;
        Ok(output.proof)
    })();
    return_bytes(&mut env, result)
}

/// An empty string means "no override"; anything else must be exactly 32 bytes of hex.
///
/// Refusing a short or malformed value rather than padding it: a binding input is a field element the
/// caller chose, and a padded one would prove a statement nobody asked for.
fn decode_binding(hex_text: &str) -> Result<Option<[u8; 32]>, String> {
    if hex_text.is_empty() {
        return Ok(None);
    }
    if hex_text.len() != 64 {
        return Err(format!(
            "a binding input is 32 bytes of hex, got {} characters",
            hex_text.len()
        ));
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex_text[i * 2..i * 2 + 2], 16)
            .map_err(|e| format!("binding input is not hex: {e}"))?;
    }
    Ok(Some(out))
}

fn read_file_arg(env: &mut JNIEnv, path: &JString, what: &str) -> Result<Vec<u8>, String> {
    let path: String = env
        .get_string(path)
        .map_err(|e| format!("{what} path: {e}"))?
        .into();
    std::fs::read(&path).map_err(|e| format!("read {what} at {path}: {e}"))
}

/// Prove one circuit invocation. The large static artifacts (zkir, keys, KZG params) are passed
/// as file paths — they are multi-MB cached files on device, and marshalling them through JNI
/// per call would be pure overhead. The per-call preimage comes in as bytes; the tagged
/// serialized proof comes back as bytes.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_proveCircuit<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    preimage: JByteArray<'local>,
) -> jbyteArray {
    let result = (|| {
        let zkir = read_file_arg(&mut env, &zkir_path, "zkir")?;
        let prover_key = read_file_arg(&mut env, &prover_key_path, "prover key")?;
        let verifier_key = read_file_arg(&mut env, &verifier_key_path, "verifier key")?;
        let params = read_file_arg(&mut env, &params_path, "KZG params")?;
        let preimage = env
            .convert_byte_array(&preimage)
            .map_err(|e| e.to_string())?;
        let output = prove_circuit(&zkir, &prover_key, &verifier_key, &params, &preimage)?;
        Ok(output.proof)
    })();
    return_bytes(&mut env, result)
}

/// Build a proven-unbound `join` transaction on-device (build preimage → tx-level prove →
/// serialize), ready to POST to the service's `/chain/submit`. Static artifacts travel as file
/// paths (multi-MB, cached on device); the live contract state + address + `circleId` + witnesses
/// (`identitySk`, `personaSk`) cross as bytes; `ttlSecs` as a long; `networkId` as a string. Returns the tagged
/// `Transaction<signature,proof,pre-binding>` bytes. CPU-bound seconds — call via AsyncFunction.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildJoinProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    circle_id: JByteArray<'local>,
    invite_secret: JByteArray<'local>,
    identity_sk: JByteArray<'local>,
    persona_sk: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let circle = bytes32_arg(&env, &circle_id, "circle id")?;
        let invite = optional_bytes32_arg(&env, &invite_secret, "invite secret")?;
        let id_sk = bytes32_arg(&env, &identity_sk, "identity sk")?;
        let sk = bytes32_arg(&env, &persona_sk, "persona sk")?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        build_join_proven_tx(
            &state,
            address,
            circle,
            invite,
            id_sk,
            sk,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// The circuit's K (log2 rows) from its `.bzkir` — names the SRS the app must fetch
/// (`bls_midnight_2p<K>`). Small input (the bzkir is < 1 KB); returns the K as an int.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_circuitK<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir: JByteArray<'local>,
) -> jint {
    let result = (|| {
        let zkir = env.convert_byte_array(&zkir).map_err(|e| e.to_string())?;
        circuit_k(&zkir).map(|k| k as jint)
    })();
    match result {
        Ok(k) => k,
        Err(message) => {
            let _ = env.throw_new("java/lang/RuntimeException", message);
            -1
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_shieldedPublicKeys<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    key: JByteArray<'local>,
) -> jbyteArray {
    let result = role_key(&env, &key)
        .and_then(|k| {
            shielded_public_keys(&k).map_err(|c| format!("shielded derive failed (code {c})"))
        })
        .map(|p| p.to_vec());
    return_bytes(&mut env, result)
}

fn return_string(env: &mut JNIEnv, result: Result<String, String>) -> jstring {
    match result {
        Ok(s) => env
            .new_string(s)
            .map(|s| s.into_raw())
            .unwrap_or(std::ptr::null_mut()),
        Err(message) => {
            let _ = env.throw_new("java/lang/RuntimeException", message);
            std::ptr::null_mut()
        }
    }
}

/// Read one identity row from Pnyx's contract state. A pure read — the TS layer owns fetching the
/// state (now straight from the indexer, so no service learns which identity was looked up).
/// `null` means unpublished; a thrown exception means the read failed.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_identityRow<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    state: JByteArray<'local>,
    identity: JByteArray<'local>,
) -> jstring {
    let result = (|| {
        let state = env.convert_byte_array(&state).map_err(|e| e.to_string())?;
        let identity = env
            .convert_byte_array(&identity)
            .map_err(|e| e.to_string())?;
        let c: [u8; 32] = identity
            .as_slice()
            .try_into()
            .map_err(|_| format!("identity must be 32 bytes, got {}", identity.len()))?;
        identity_mod::identity_row_json(&state, c)
    })();
    return_string(&mut env, result)
}

/// A member's merkle path out of a circle's contract state (20 × 33 bytes).
///
/// The state is whatever the caller fetched — normally the circle as of the proposal's own height,
/// because a proposal seals its electorate's root and a path read from a later state has a different
/// one.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_circleMemberPath<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    state: JByteArray<'local>,
    leaf: JByteArray<'local>,
) -> jbyteArray {
    let result = (|| {
        let state = env.convert_byte_array(&state).map_err(|e| e.to_string())?;
        let leaf = bytes32_arg(&env, &leaf, "member leaf")?;
        circle_mod::member_path(&state, leaf)
    })();
    return_bytes(&mut env, result)
}

/// A moderator's merkle path out of a circle's contract state (10 × 33 bytes).
///
/// A shallower tree than `members`, and the depth is what makes it a separate call rather than a
/// parameter: a 20-entry path hashes to a root `requireModerator` never matches.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_circleModeratorPath<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    state: JByteArray<'local>,
    leaf: JByteArray<'local>,
) -> jbyteArray {
    let result = (|| {
        let state = env.convert_byte_array(&state).map_err(|e| e.to_string())?;
        let leaf = bytes32_arg(&env, &leaf, "moderator leaf")?;
        circle_mod::moderator_path(&state, leaf)
    })();
    return_bytes(&mut env, result)
}

/// The root of a circle's members tree, little-endian.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_circleMembersRoot<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    state: JByteArray<'local>,
) -> jbyteArray {
    let result = (|| {
        let state = env.convert_byte_array(&state).map_err(|e| e.to_string())?;
        circle_mod::members_root(&state).map(|root| root.to_vec())
    })();
    return_bytes(&mut env, result)
}

/// A circle's `inviteAuthority` commitment, or an **empty** array when it has delegated to nobody.
///
/// Empty is an answer: "nobody" and "we could not read it" are different facts, and only the first
/// means a founder should be offered the control that turns delegation on. A read failure throws, as
/// every other binding here does.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_circleInviteAuthority<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    state: JByteArray<'local>,
) -> jbyteArray {
    let result = (|| {
        let state = env.convert_byte_array(&state).map_err(|e| e.to_string())?;
        circle_mod::invite_authority(&state)
            .map(|authority| authority.map(|a| a.to_vec()).unwrap_or_default())
    })();
    return_bytes(&mut env, result)
}

// `buildClaimNameProvenTx` / `buildReleaseNameProvenTx` were removed on 2026-08-24: handles left
// `identity.compact` for a per-name contract (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.2), whose
// claim path is `bind`/`rebind` and takes a permit rather than a name and a flag. Re-added with
// `handle.compact`, not repointed — the arguments differ.

/// Resolve a handle to the `C` that holds it. Empty string means unclaimed; a thrown exception
/// means the read failed. The caller must label the peer from that `C`'s row, never from the handle
/// it passed in — see [`crate::identity::name_owner`].
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_nameOwner<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    state: JByteArray<'local>,
    name: JByteArray<'local>,
) -> jstring {
    let result = (|| {
        let state = env.convert_byte_array(&state).map_err(|e| e.to_string())?;
        let name = env.convert_byte_array(&name).map_err(|e| e.to_string())?;
        let handle: [u8; 32] = name
            .as_slice()
            .try_into()
            .map_err(|_| format!("name must be 32 bytes, got {}", name.len()))?;
        identity_mod::name_owner_hex(&state, handle)
    })();
    return_string(&mut env, result)
}

/// Build a proven-unbound `publishIdentityRow` transaction on-device. Unlike the forum circuits
/// this one has no circle/proposal arguments — just the row and the identity secret.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildPublishRowProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    anchor: JByteArray<'local>,
    auth_pub: JByteArray<'local>,
    identity_sk: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let anchor = bytes32_arg(&env, &anchor, "anchor")?;
        let auth_pub = bytes32_arg(&env, &auth_pub, "authPub")?;
        let sk = bytes32_arg(&env, &identity_sk, "identity sk")?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_publish_row_proven_tx(
            &state,
            address,
            anchor,
            auth_pub,
            sk,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// Build a proven-unbound `setPrimaryName` transaction on-device.
///
/// Unvalidated on chain by design: ownership lives in the per-name handle contract and
/// contract-to-contract calls do not exist, so this cell is a *claim* that readers check both ways.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildSetPrimaryNameProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    name: JByteArray<'local>,
    identity_sk: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let handle = bytes32_arg(&env, &name, "name")?;
        let sk = bytes32_arg(&env, &identity_sk, "identity sk")?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_set_primary_name_proven_tx(
            &state,
            address,
            handle,
            sk,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// Build a proven-unbound `setRow` transaction on-device — one card row.
///
/// `value` is the full 320-byte row field; its length prefix and flags are the client's format, so it
/// crosses as opaque bytes. Kind 0 clears the slot, and the builder refuses to clear one the card does
/// not hold rather than producing a transcript the node rejects.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildSetRowProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    slot: jint,
    kind: jint,
    value: JByteArray<'local>,
    identity_sk: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let row = env.convert_byte_array(&value).map_err(|e| e.to_string())?;
        let sk = bytes32_arg(&env, &identity_sk, "identity sk")?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        let slot =
            u8::try_from(slot).map_err(|_| format!("card slot {slot} does not fit a byte"))?;
        let kind =
            u8::try_from(kind).map_err(|_| format!("card kind {kind} does not fit a byte"))?;
        crate::preimage::build_set_row_proven_tx(
            &state,
            address,
            slot,
            kind,
            &row,
            sk,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// Build a proven-unbound `setRows` transaction on-device — the "save my card" path.
///
/// Exactly four slots, because the template's width is fixed. `slots` and `kinds` are int arrays and
/// `values` is the four 320-byte rows concatenated — one flat array rather than an array-of-arrays,
/// which JNI makes needlessly awkward for a fixed width.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildSetRowsProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    slots: JIntArray<'local>,
    kinds: JIntArray<'local>,
    values: JByteArray<'local>,
    identity_sk: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let sk = bytes32_arg(&env, &identity_sk, "identity sk")?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();

        let mut slot_buf = [0i32; 4];
        env.get_int_array_region(&slots, 0, &mut slot_buf)
            .map_err(|e| format!("read slots: {e}"))?;
        let mut kind_buf = [0i32; 4];
        env.get_int_array_region(&kinds, 0, &mut kind_buf)
            .map_err(|e| format!("read kinds: {e}"))?;
        let flat = env.convert_byte_array(&values).map_err(|e| e.to_string())?;
        if flat.len() != 4 * 320 {
            return Err(format!(
                "setRows values must be {} bytes (4 x 320), got {}",
                4 * 320,
                flat.len()
            ));
        }
        let writes: Result<Vec<crate::preimage::CardWrite>, String> = (0..4)
            .map(|i| {
                Ok(crate::preimage::CardWrite {
                    slot: u8::try_from(slot_buf[i])
                        .map_err(|_| format!("slot {} does not fit a byte", slot_buf[i]))?,
                    kind: u8::try_from(kind_buf[i])
                        .map_err(|_| format!("kind {} does not fit a byte", kind_buf[i]))?,
                    value: flat[i * 320..(i + 1) * 320].to_vec(),
                })
            })
            .collect();
        crate::preimage::build_set_rows_proven_tx(
            &state,
            address,
            &writes?,
            sk,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

// ── Circle deploy (crate::deploy) ──
//
// No proving and no per-circuit artifacts: a constructor is not a circuit. `keysDir` holds every
// entry point's `.verifier`, and the deploy's whole input is the four constructor arguments.

/// Build the unproven, unbalanced deploy transaction for a circle.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildCircleDeployTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    keys_dir: JString<'local>,
    circle_id: JByteArray<'local>,
    is_open: jboolean,
    founder: JByteArray<'local>,
    founder_auth: JByteArray<'local>,
    founder_joined: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let dir: String = env.get_string(&keys_dir).map_err(|e| e.to_string())?.into();
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        let circle = bytes32_arg(&env, &circle_id, "circle id")?;
        let founder = bytes32_arg(&env, &founder, "founder")?;
        let founder_auth = bytes32_arg(&env, &founder_auth, "founder auth")?;
        let founder_joined = bytes32_arg(&env, &founder_joined, "founder join nullifier")?;
        let keys = crate::deploy::read_circle_verifier_keys(&dir)?;
        crate::deploy::build_circle_deploy_tx(
            circle,
            is_open != 0,
            founder,
            founder_auth,
            founder_joined,
            &keys,
            &network,
            ttl_secs as u64,
        )
        .map(|(bytes, _address)| bytes)
    })();
    return_bytes(&mut env, result)
}

/// The 32-byte address a circle's constructor arguments imply, without building a transaction.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_circleDeployAddress<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    keys_dir: JString<'local>,
    circle_id: JByteArray<'local>,
    is_open: jboolean,
    founder: JByteArray<'local>,
    founder_auth: JByteArray<'local>,
    founder_joined: JByteArray<'local>,
) -> jbyteArray {
    let result = (|| {
        let dir: String = env.get_string(&keys_dir).map_err(|e| e.to_string())?.into();
        let circle = bytes32_arg(&env, &circle_id, "circle id")?;
        let founder = bytes32_arg(&env, &founder, "founder")?;
        let founder_auth = bytes32_arg(&env, &founder_auth, "founder auth")?;
        let founder_joined = bytes32_arg(&env, &founder_joined, "founder join nullifier")?;
        let keys = crate::deploy::read_circle_verifier_keys(&dir)?;
        crate::deploy::circle_deploy_address(circle, is_open != 0, founder, founder_auth, founder_joined, &keys)
            .map(|a| a.to_vec())
    })();
    return_bytes(&mut env, result)
}

/// Build a proven-unbound `claimFreePermit` transaction on-device — a tier permit out of the free tier.
///
/// `tier` is 0..=6 and `recipient` is 32 bytes. Unlike `bind`, the result needs no unshielded input of
/// its own: the call spends nothing, so the sponsor's fee segment is the whole of what it needs.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildClaimFreePermitProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    tier: jint,
    recipient: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let to = bytes32_arg(&env, &recipient, "recipient")?;
        let tier = u8::try_from(tier).map_err(|_| format!("tier must be 0..6, got {tier}"))?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_claim_free_permit_proven_tx(
            &state,
            address,
            tier,
            to,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// Build a proven-unbound `bind` transaction on-device — a handle claim.
///
/// ⚠️ The resulting transaction **does not balance on its own**: `bind` spends a tier permit, so the
/// caller has to add the permit UTxO as an unshielded input before submitting. That is deliberate —
/// the permit is an ordinary ledger UTxO, so funding it is the wallet's job, not this builder's.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildBindProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    identity_sk: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let sk = bytes32_arg(&env, &identity_sk, "identity sk")?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_bind_proven_tx(
            &state,
            address,
            sk,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// Build a proven-unbound `rebind` transaction on-device — hand a handle to another identity.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildRebindProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    new_owner: JByteArray<'local>,
    identity_sk: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let new_owner = bytes32_arg(&env, &new_owner, "new owner")?;
        let sk = bytes32_arg(&env, &identity_sk, "identity sk")?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_rebind_proven_tx(
            &state,
            address,
            new_owner,
            sk,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// The address a handle contract deploys to — a pure derivation over the canonical name.
///
/// This is what makes a name lookup free: hash the name, get the address, ask the indexer whether
/// anything is there. **No proving, no network, no download.**
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_handleAddress<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    keys_dir: JString<'local>,
    name: JByteArray<'local>,
    payment: JByteArray<'local>,
) -> jbyteArray {
    let result = (|| {
        let dir: String = env.get_string(&keys_dir).map_err(|e| e.to_string())?.into();
        let name = bytes32_arg(&env, &name, "name")?;
        let payment = bytes32_arg(&env, &payment, "payment address")?;
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::HANDLE_ENTRY_POINTS)?;
        crate::deploy::handle_deploy_address(name, payment, &keys).map(|a| a.to_vec())
    })();
    return_bytes(&mut env, result)
}

/// The address an identity contract deploys to — a pure derivation over `C`.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_identityAddress<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    keys_dir: JString<'local>,
    c: JByteArray<'local>,
) -> jbyteArray {
    let result = (|| {
        let dir: String = env.get_string(&keys_dir).map_err(|e| e.to_string())?.into();
        let c = bytes32_arg(&env, &c, "identity commitment")?;
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::IDENTITY_ENTRY_POINTS)?;
        crate::deploy::identity_deploy_address(c, &keys).map(|a| a.to_vec())
    })();
    return_bytes(&mut env, result)
}

/// An unproven, unbalanced identity-shell deploy, plus the address it will create.
///
/// The first transaction a new identity makes: one contract per identity, so the shell has to exist
/// before `publishIdentityRow` has anywhere to write. Returns `address ‖ tx` — the address is
/// derivable from `C` alone, so a caller never has to trust anyone's answer to "which contract did
/// that create?".
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildIdentityDeployTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    keys_dir: JString<'local>,
    c: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let dir: String = env.get_string(&keys_dir).map_err(|e| e.to_string())?.into();
        let c = bytes32_arg(&env, &c, "identity commitment")?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::IDENTITY_ENTRY_POINTS)?;
        let (tx, address) =
            crate::deploy::build_identity_deploy_tx(c, &keys, &network, ttl_secs as u64)?;
        let mut out = address.to_vec();
        out.extend_from_slice(&tx);
        Ok(out)
    })();
    return_bytes(&mut env, result)
}

/// An unproven, unbalanced handle-shell deploy, plus the address it will create.
///
/// Returns `address ‖ tx`, since a caller must never have to trust anyone else's answer to "which
/// contract did that create?" — and here the answer is checkable offline from the name alone.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildHandleDeployTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    keys_dir: JString<'local>,
    name: JByteArray<'local>,
    payment: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let dir: String = env.get_string(&keys_dir).map_err(|e| e.to_string())?.into();
        let name = bytes32_arg(&env, &name, "name")?;
        let payment = bytes32_arg(&env, &payment, "payment address")?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::HANDLE_ENTRY_POINTS)?;
        let (tx, address) =
            crate::deploy::build_handle_deploy_tx(name, payment, &keys, &network, ttl_secs as u64)?;
        let mut out = address.to_vec();
        out.extend_from_slice(&tx);
        Ok(out)
    })();
    return_bytes(&mut env, result)
}

/// `setInvite` on-device — issue or revoke a circle invite. Moderator-gated.
///
/// The moderator path is 10 x 33 bytes, half a member path: `moderators` is a
/// `HistoricMerkleTree<10, …>`. A member path passed here decodes and hashes to a root matching
/// nothing, which the circuit reports as "not a moderator" — the decoder checks the depth instead.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildSetInviteProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    persona_sk: JByteArray<'local>,
    moderator_path: JByteArray<'local>,
    commitment: JByteArray<'local>,
    active: jboolean,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let sk = bytes32_arg(&env, &persona_sk, "persona sk")?;
        let commitment = bytes32_arg(&env, &commitment, "invite commitment")?;
        let path_bytes = env
            .convert_byte_array(&moderator_path)
            .map_err(|e| e.to_string())?;
        let path = crate::preimage::moderator_path_from_bytes(&path_bytes)?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_set_invite_proven_tx(
            &state,
            address,
            sk,
            &path,
            commitment,
            active != 0,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// `issueInvite` on-device — the delegated authority's issuance, and the one privileged circuit that
/// takes **no Merkle path**.
///
/// That is the shape, not an omission: the authority is a commitment in a ledger cell, not a leaf in
/// `moderators`, so there is nothing to compute a path against. A caller holding the wrong secret is
/// refused by the builder before proving.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildIssueInviteProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    authority_sk: JByteArray<'local>,
    commitment: JByteArray<'local>,
    active: jboolean,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let sk = bytes32_arg(&env, &authority_sk, "invite authority sk")?;
        let commitment = bytes32_arg(&env, &commitment, "invite commitment")?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_issue_invite_proven_tx(
            &state,
            address,
            sk,
            commitment,
            active != 0,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// `setInviteAuthority` on-device — delegate, rotate, or withdraw. Moderator-gated, so it takes a
/// 10 x 33 moderator path like `setInvite`.
///
/// Writing 32 zero bytes withdraws the delegation, which is the property that made an authority
/// preferable to promoting the attestor: `moderators` is insert-only.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildSetInviteAuthorityProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    persona_sk: JByteArray<'local>,
    moderator_path: JByteArray<'local>,
    authority: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let sk = bytes32_arg(&env, &persona_sk, "persona sk")?;
        let authority = bytes32_arg(&env, &authority, "invite authority commitment")?;
        let path_bytes = env
            .convert_byte_array(&moderator_path)
            .map_err(|e| e.to_string())?;
        let path = crate::preimage::moderator_path_from_bytes(&path_bytes)?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_set_invite_authority_proven_tx(
            &state,
            address,
            sk,
            &path,
            authority,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// Serve one Compact-runtime leaf. JSON in, JSON out — see `compact.rs`.
#[no_mangle]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_compactOp<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    op: JString<'local>,
    args: JString<'local>,
) -> jstring {
    let result = (|| {
        let op: String = env.get_string(&op).map_err(|e| e.to_string())?.into();
        let args: String = env.get_string(&args).map_err(|e| e.to_string())?.into();
        crate::compact::compact_op(&op, &args)
    })();
    return_string(&mut env, result)
}

/// `leaveCircle` on-device — remove your own leaf, self-authorised.
///
/// ⚠️ **One-way.** The join nullifier is never released, so a leaver cannot rejoin. The refusal
/// arrives at `join` as "identity already joined", far from here — the warning belongs in the UI.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildLeaveCircleProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    persona_sk: JByteArray<'local>,
    member_path: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let sk = bytes32_arg(&env, &persona_sk, "persona sk")?;
        let path_bytes = env
            .convert_byte_array(&member_path)
            .map_err(|e| e.to_string())?;
        let path = crate::preimage::member_path_from_bytes(&path_bytes)?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_leave_circle_proven_tx(
            &state,
            address,
            sk,
            &path,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// `addModerator` on-device — promote a member. Two paths of different heights: the caller's moderator
/// path (10 x 33) and the target's member path (20 x 33).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildAddModeratorProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    persona_sk: JByteArray<'local>,
    moderator_path: JByteArray<'local>,
    target_leaf: JByteArray<'local>,
    member_path: JByteArray<'local>,
    auth_pub: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let sk = bytes32_arg(&env, &persona_sk, "persona sk")?;
        let target = bytes32_arg(&env, &target_leaf, "target leaf")?;
        let auth = bytes32_arg(&env, &auth_pub, "auth pub")?;
        let mod_bytes = env
            .convert_byte_array(&moderator_path)
            .map_err(|e| e.to_string())?;
        let member_bytes = env
            .convert_byte_array(&member_path)
            .map_err(|e| e.to_string())?;
        let mod_path = crate::preimage::moderator_path_from_bytes(&mod_bytes)?;
        let member = crate::preimage::member_path_from_bytes(&member_bytes)?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_add_moderator_proven_tx(
            &state,
            address,
            sk,
            &mod_path,
            target,
            &member,
            auth,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// `castVote` on-device. The member path is a parameter — a proposal seals its electorate and holds no
/// tree, so the caller supplies the path as of the sealed root (20 x 33 bytes).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildCastVoteProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    persona_sk: JByteArray<'local>,
    ballot_option: jint,
    ballot_rand: JByteArray<'local>,
    member_path: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let sk = bytes32_arg(&env, &persona_sk, "persona sk")?;
        let rand = bytes32_arg(&env, &ballot_rand, "ballot rand")?;
        let path_bytes = env
            .convert_byte_array(&member_path)
            .map_err(|e| e.to_string())?;
        let path = crate::preimage::member_path_from_bytes(&path_bytes)?;
        let option =
            u8::try_from(ballot_option).map_err(|_| "ballot option must be 0..255".to_string())?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_cast_vote_proven_tx(
            &state,
            address,
            sk,
            option,
            rand,
            &path,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// `revealVote` on-device. No member path — the nullifier already proves this persona voted while an
/// elector, and a vote should not be voided by a later departure.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildRevealVoteProvenTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    zkir_path: JString<'local>,
    prover_key_path: JString<'local>,
    verifier_key_path: JString<'local>,
    params_path: JString<'local>,
    contract_state: JByteArray<'local>,
    contract_address: JByteArray<'local>,
    persona_sk: JByteArray<'local>,
    ballot_option: jint,
    ballot_rand: JByteArray<'local>,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let (zkir, prover_key, verifier_key, params) = read_artifacts(
            &mut env,
            &zkir_path,
            &prover_key_path,
            &verifier_key_path,
            &params_path,
        )?;
        let state = env
            .convert_byte_array(&contract_state)
            .map_err(|e| e.to_string())?;
        let address = bytes32_arg(&env, &contract_address, "contract address")?;
        let sk = bytes32_arg(&env, &persona_sk, "persona sk")?;
        let rand = bytes32_arg(&env, &ballot_rand, "ballot rand")?;
        let option =
            u8::try_from(ballot_option).map_err(|_| "ballot option must be 0..255".to_string())?;
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        crate::preimage::build_reveal_vote_proven_tx(
            &state,
            address,
            sk,
            option,
            rand,
            &zkir,
            &prover_key,
            &verifier_key,
            &params,
            &network,
            ttl_secs as u64,
        )
    })();
    return_bytes(&mut env, result)
}

/// The address a proposal deploys to — a pure derivation, no proving and no network.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_proposalAddress<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    keys_dir: JString<'local>,
    circle_id: JByteArray<'local>,
    members_root: JByteArray<'local>,
    content: JByteArray<'local>,
    author: JByteArray<'local>,
    option_count: jint,
) -> jbyteArray {
    let result = (|| {
        let dir: String = env.get_string(&keys_dir).map_err(|e| e.to_string())?.into();
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::PROPOSAL_ENTRY_POINTS)?;
        let root = fr_arg(&env, &members_root)?;
        let count =
            u8::try_from(option_count).map_err(|_| "optionCount must be 0..255".to_string())?;
        crate::deploy::proposal_deploy_address(
            bytes32_arg(&env, &circle_id, "circle id")?,
            root,
            bytes32_arg(&env, &content, "content")?,
            bytes32_arg(&env, &author, "author")?,
            count,
            &keys,
        )
        .map(|a| a.to_vec())
    })();
    return_bytes(&mut env, result)
}

/// An unproven, unbalanced proposal deploy, plus the address it will create (`address ‖ tx`).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_expo_modules_midnightnative_MidnightNativeModule_buildProposalDeployTx<
    'local,
>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    keys_dir: JString<'local>,
    circle_id: JByteArray<'local>,
    members_root: JByteArray<'local>,
    content: JByteArray<'local>,
    author: JByteArray<'local>,
    option_count: jint,
    network_id: JString<'local>,
    ttl_secs: jlong,
) -> jbyteArray {
    let result = (|| {
        let dir: String = env.get_string(&keys_dir).map_err(|e| e.to_string())?.into();
        let network: String = env
            .get_string(&network_id)
            .map_err(|e| e.to_string())?
            .into();
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::PROPOSAL_ENTRY_POINTS)?;
        let root = fr_arg(&env, &members_root)?;
        let count =
            u8::try_from(option_count).map_err(|_| "optionCount must be 0..255".to_string())?;
        let (tx, address) = crate::deploy::build_proposal_deploy_tx(
            bytes32_arg(&env, &circle_id, "circle id")?,
            root,
            bytes32_arg(&env, &content, "content")?,
            bytes32_arg(&env, &author, "author")?,
            count,
            &keys,
            &network,
            ttl_secs as u64,
        )?;
        let mut out = address.to_vec();
        out.extend_from_slice(&tx);
        Ok(out)
    })();
    return_bytes(&mut env, result)
}
