//! C-ABI exports for the proven-tx builders + circuit metadata — the iOS side of the bridge
//! (Swift binds these via `@_silgen_name`; the C contract lives in `include/midnight_native.h`).
//! Mirrors the Android JNI surface in `jni_bridge.rs`: static artifacts travel as file paths,
//! dynamic data as `(ptr, len)` byte buffers, and every returned buffer — the tx bytes on
//! success, the UTF-8 error message on failure — is released with `midnight_buffer_free`.
//!
//! The key-derivation and byte-based single-circuit exports predate this module and live in
//! `lib.rs`; new C entry points go here.

use std::ffi::CStr;
use std::os::raw::c_char;

use crate::preimage::build_join_proven_tx;
use crate::prove::{check_preimage, circuit_k, prove_circuit, prove_circuit_binding};

/// A `Field` as it crosses the bridge: 32 little-endian bytes, matching `Fr::as_le_bytes`. Refused
/// rather than reduced if it is not a canonical field element — a silently reduced root would derive a
/// different proposal address.
fn fr_from_le(bytes: &[u8; 32]) -> Result<midnight_transient_crypto::curve::Fr, String> {
    midnight_transient_crypto::curve::Fr::from_le_bytes(bytes)
        .ok_or_else(|| "members root is not a canonical field element".to_string())
}

const OK: i32 = 0;
const ERR_NULL: i32 = 1;
/// The operation failed; `*out_err` holds a UTF-8 message (release with `midnight_buffer_free`).
const ERR_FAILED: i32 = 5;

/// # Safety
/// `ptr` is a valid NUL-terminated C string.
unsafe fn path_arg(ptr: *const c_char, what: &str) -> Result<String, String> {
    CStr::from_ptr(ptr)
        .to_str()
        .map(str::to_owned)
        .map_err(|e| format!("{what} is not UTF-8: {e}"))
}

fn read_file(path: &str, what: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("read {what} at {path}: {e}"))
}

/// The four static proving artifacts as bytes, read from their on-device file paths — the
/// shared prefix of every proven-tx builder (same shape as `jni_bridge::read_artifacts`).
///
/// # Safety
/// Each pointer is a valid NUL-terminated C string.
unsafe fn read_artifacts(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>), String> {
    Ok((
        read_file(&path_arg(zkir_path, "zkir path")?, "zkir")?,
        read_file(&path_arg(prover_key_path, "prover key path")?, "prover key")?,
        read_file(
            &path_arg(verifier_key_path, "verifier key path")?,
            "verifier key",
        )?,
        read_file(&path_arg(params_path, "KZG params path")?, "KZG params")?,
    ))
}

/// # Safety
/// `out`/`out_len` are writable. Ownership of the buffer transfers to the caller.
unsafe fn write_buffer(bytes: Vec<u8>, out: *mut *mut u8, out_len: *mut usize) {
    let boxed = bytes.into_boxed_slice();
    *out_len = boxed.len();
    *out = Box::into_raw(boxed) as *mut u8;
}

/// # Safety
/// All four out-pointers are writable.
unsafe fn finish(
    result: Result<Vec<u8>, String>,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    match result {
        Ok(bytes) => {
            write_buffer(bytes, out, out_len);
            OK
        }
        Err(message) => {
            write_buffer(message.into_bytes(), out_err, out_err_len);
            ERR_FAILED
        }
    }
}

/// The circuit's K (log2 rows) from its `.bzkir` bytes — names the SRS to fetch
/// (`bls_midnight_2p<K>`).
///
/// # Safety
/// `zkir` points to `zkir_len` readable bytes; `out_k`, `out_err`, `out_err_len` are writable.
/// On `ERR_FAILED` the caller releases `*out_err` via `midnight_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn midnight_circuit_k(
    zkir: *const u8,
    zkir_len: usize,
    out_k: *mut u32,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if zkir.is_null() || out_k.is_null() || out_err.is_null() || out_err_len.is_null() {
        return ERR_NULL;
    }
    match circuit_k(std::slice::from_raw_parts(zkir, zkir_len)) {
        Ok(k) => {
            *out_k = u32::from(k);
            OK
        }
        Err(message) => {
            write_buffer(message.into_bytes(), out_err, out_err_len);
            ERR_FAILED
        }
    }
}

/// Path-based variant of `midnight_prove_circuit`: the static artifacts are read from disk
/// natively (multi-MB cached files — marshalling them through the FFI per call is pure
/// overhead), only the per-call preimage crosses as bytes. Failures carry a message.
///
/// # Safety
/// The `check` half of the connector's proving provider — JSON array of `number | null`.
///
/// # Safety
/// `zkir` and `preimage` point to readable byte ranges of the stated length; the out-pointers are
/// writable. The returned buffer is released with `midnight_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn midnight_check_preimage(
    zkir: *const u8,
    zkir_len: usize,
    preimage: *const u8,
    preimage_len: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if zkir.is_null()
        || preimage.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = check_preimage(
        std::slice::from_raw_parts(zkir, zkir_len),
        std::slice::from_raw_parts(preimage, preimage_len),
    )
    .map(|skips| {
        let items: Vec<String> = skips
            .iter()
            .map(|s| match s {
                Some(v) => v.to_string(),
                None => "null".to_string(),
            })
            .collect();
        format!("[{}]", items.join(",")).into_bytes()
    });
    finish(result, out, out_len, out_err, out_err_len)
}

/// `midnight_prove_circuit_files` with the caller's binding input replacing the preimage's.
///
/// `binding_le` is either null (leave the preimage alone) or 32 readable bytes, little-endian.
///
/// # Safety
/// As `midnight_prove_circuit_files`, plus: `binding_le` is null or points to 32 readable bytes.
#[no_mangle]
pub unsafe extern "C" fn midnight_prove_preimage_with_binding(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    preimage: *const u8,
    preimage_len: usize,
    binding_le: *const u8,
    out_proof: *mut *mut u8,
    out_proof_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if zkir_path.is_null()
        || prover_key_path.is_null()
        || verifier_key_path.is_null()
        || params_path.is_null()
        || preimage.is_null()
        || out_proof.is_null()
        || out_proof_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let preimage = std::slice::from_raw_parts(preimage, preimage_len);
    let binding: Option<[u8; 32]> = if binding_le.is_null() {
        None
    } else {
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(std::slice::from_raw_parts(binding_le, 32));
        Some(bytes)
    };
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            prove_circuit_binding(
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                preimage,
                binding.as_ref(),
            )
        })
        .map(|output| output.proof);
    finish(result, out_proof, out_proof_len, out_err, out_err_len)
}

/// Paths are valid NUL-terminated C strings; `preimage` points to `preimage_len` readable
/// bytes; the out-pointers are writable. The returned buffer (proof or error message) is
/// released with `midnight_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn midnight_prove_circuit_files(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    preimage: *const u8,
    preimage_len: usize,
    out_proof: *mut *mut u8,
    out_proof_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if zkir_path.is_null()
        || prover_key_path.is_null()
        || verifier_key_path.is_null()
        || params_path.is_null()
        || preimage.is_null()
        || out_proof.is_null()
        || out_proof_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let preimage = std::slice::from_raw_parts(preimage, preimage_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            prove_circuit(&zkir, &prover_key, &verifier_key, &params, preimage)
        })
        .map(|output| output.proof);
    finish(result, out_proof, out_proof_len, out_err, out_err_len)
}

/// Build a proven-unbound `join` transaction on-device (build preimage → tx-level
/// prove → serialize), ready to POST to the service's `/chain/submit`. Returns the tagged
/// `Transaction<signature,proof,pre-binding>` bytes. CPU-bound seconds — call off the main
/// thread.
///
/// # Safety
/// Paths and `network_id` are valid NUL-terminated C strings; `contract_state` points to
/// `contract_state_len` readable bytes; `contract_address`, `circle_id`, `identity_sk` and
/// `persona_sk` point to 32 readable bytes each; the out-pointers are writable. The returned buffer
/// (tx bytes or error message) is released with `midnight_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn midnight_build_join_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    circle_id: *const u8,
    invite_secret: *const u8,
    identity_sk: *const u8,
    persona_sk: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if zkir_path.is_null()
        || prover_key_path.is_null()
        || verifier_key_path.is_null()
        || params_path.is_null()
        || contract_state.is_null()
        || contract_address.is_null()
        || circle_id.is_null()
        || identity_sk.is_null()
        || persona_sk.is_null()
        || network_id.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let address = *(contract_address as *const [u8; 32]);
    let circle = *(circle_id as *const [u8; 32]);
    // ⚠️ NULL is the open circle, deliberately — it is the one pointer here that may be null, because
    // "no invite" is the open arm rather than a missing argument.
    let invite = if invite_secret.is_null() {
        None
    } else {
        Some(*(invite_secret as *const [u8; 32]))
    };
    let id_sk = *(identity_sk as *const [u8; 32]);
    let sk = *(persona_sk as *const [u8; 32]);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            build_join_proven_tx(
                state,
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
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// One Pnyx identity row from contract state.
///
/// Shielded wallet state: every op returning a new state (`new`, `applyCollapsedUpdate`,
/// `insertCoin`, `watchFor`). One export per return shape rather than per op — see
/// [`crate::wallet::state_op`].
///
/// # Safety
/// `op` is a valid NUL-terminated C string; `state`/`arg` point to their stated lengths (either may
/// be empty, in which case the pointer is still non-null); `zswap_role_key` points to 32 readable
/// bytes; the out-pointers are writable. Release `*out` / `*out_err` via `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_wallet_state_op(
    op: *const c_char,
    state: *const u8,
    state_len: usize,
    zswap_role_key: *const u8,
    arg: *const u8,
    arg_len: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if op.is_null()
        || state.is_null()
        || zswap_role_key.is_null()
        || arg.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = (|| {
        let op = path_arg(op, "wallet op")?;
        let mut key = [0u8; 32];
        key.copy_from_slice(std::slice::from_raw_parts(zswap_role_key, 32));
        crate::wallet::state_op(
            &op,
            std::slice::from_raw_parts(state, state_len),
            &key,
            std::slice::from_raw_parts(arg, arg_len),
        )
    })();
    finish(result, out, out_len, out_err, out_err_len)
}

/// Build + prove a shielded transfer. On `OK` the out-buffer holds JSON `{"tx","state"}`.
///
/// # Safety
/// `network_id`, `artifact_dir` and `params_dir` are valid NUL-terminated C strings; `state` points to
/// `state_len` bytes; `zswap_role_key`, `recipient_coin_public_key` and `color` to 32 each; `value_le`
/// to 16 (u128, little-endian); `recipient_encryption_public_key` to its stated length. Release `*out`
/// / `*out_err` via `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_wallet_build_transfer(
    state: *const u8,
    state_len: usize,
    zswap_role_key: *const u8,
    recipient_coin_public_key: *const u8,
    recipient_encryption_public_key: *const u8,
    recipient_encryption_public_key_len: usize,
    color: *const u8,
    value_le: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    artifact_dir: *const c_char,
    params_dir: *const c_char,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if state.is_null()
        || zswap_role_key.is_null()
        || recipient_coin_public_key.is_null()
        || recipient_encryption_public_key.is_null()
        || color.is_null()
        || value_le.is_null()
        || network_id.is_null()
        || artifact_dir.is_null()
        || params_dir.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = (|| {
        crate::wallet::build_transfer_json(
            std::slice::from_raw_parts(state, state_len),
            &*(zswap_role_key as *const [u8; 32]),
            &*(recipient_coin_public_key as *const [u8; 32]),
            std::slice::from_raw_parts(
                recipient_encryption_public_key,
                recipient_encryption_public_key_len,
            ),
            &*(color as *const [u8; 32]),
            &*(value_le as *const [u8; 16]),
            &path_arg(network_id, "network id")?,
            ttl_secs,
            &path_arg(artifact_dir, "artifact dir")?,
            &path_arg(params_dir, "params dir")?,
        )
    })();
    finish(
        result.map(String::into_bytes),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

/// Build + sign an unshielded transfer. On `OK` the out-buffer holds the proven, unbound
/// transaction as hex.
///
/// No artifacts and no proving: a transfer carries no circuit, so this needs neither a prover key
/// nor the SRS that every other builder here takes.
///
/// # Safety
/// `network_id` is a valid NUL-terminated C string; `night_role_key`, `recipient_address` and
/// `token_type` point to 32 bytes each; `value_le` to 16 (u128, little-endian); `packed_inputs` to
/// `packed_inputs_len` bytes of 84-byte records. Release `*out` / `*out_err` via
/// `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_wallet_build_unshielded_transfer(
    night_role_key: *const u8,
    packed_inputs: *const u8,
    packed_inputs_len: usize,
    recipient_address: *const u8,
    token_type: *const u8,
    value_le: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    change_chunks: u32,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if night_role_key.is_null()
        || packed_inputs.is_null()
        || recipient_address.is_null()
        || token_type.is_null()
        || value_le.is_null()
        || network_id.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = (|| {
        crate::unshielded::build_unshielded_transfer_hex(
            &*(night_role_key as *const [u8; 32]),
            std::slice::from_raw_parts(packed_inputs, packed_inputs_len),
            &*(recipient_address as *const [u8; 32]),
            &*(token_type as *const [u8; 32]),
            &*(value_le as *const [u8; 16]),
            &path_arg(network_id, "network id")?,
            ttl_secs,
            change_chunks,
        )
    })();
    finish(
        result.map(String::into_bytes),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

/// Build a transfer that pays its own DUST fee. On `OK` the out-buffer holds JSON
/// `{"tx","state","fee"}` — the sealed transaction, the dust state with its spend pending, and the fee.
///
/// Unlike `midnight_wallet_build_unshielded_transfer` this proves (the K=13 dust spend circuit) and
/// seals, so it takes artifact directories and costs real CPU.
///
/// # Safety
/// `night_role_key`, `recipient_address`, `token_type` and `dust_role_key` point to 32 bytes each;
/// `value_le` to 16 (u128, little-endian); `packed_inputs` to `packed_inputs_len` bytes of 84-byte
/// records; `dust_state` to `dust_state_len` bytes. `network_id`, `artifact_dir` and `params_dir` are
/// valid NUL-terminated C strings. Release `*out` / `*out_err` via `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_wallet_build_self_funded_transfer(
    night_role_key: *const u8,
    packed_inputs: *const u8,
    packed_inputs_len: usize,
    recipient_address: *const u8,
    token_type: *const u8,
    value_le: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    dust_state: *const u8,
    dust_state_len: usize,
    dust_role_key: *const u8,
    ctime_secs: u64,
    artifact_dir: *const c_char,
    params_dir: *const c_char,
    fee_margin: usize,
    change_chunks: u32,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if night_role_key.is_null()
        || packed_inputs.is_null()
        || recipient_address.is_null()
        || token_type.is_null()
        || value_le.is_null()
        || network_id.is_null()
        || dust_state.is_null()
        || dust_role_key.is_null()
        || artifact_dir.is_null()
        || params_dir.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = (|| {
        crate::unshielded::build_self_funded_transfer_hex(
            &*(night_role_key as *const [u8; 32]),
            std::slice::from_raw_parts(packed_inputs, packed_inputs_len),
            &*(recipient_address as *const [u8; 32]),
            &*(token_type as *const [u8; 32]),
            &*(value_le as *const [u8; 16]),
            &path_arg(network_id, "network id")?,
            ttl_secs,
            std::slice::from_raw_parts(dust_state, dust_state_len),
            &*(dust_role_key as *const [u8; 32]),
            ctime_secs,
            &path_arg(artifact_dir, "artifact dir")?,
            &path_arg(params_dir, "params dir")?,
            fee_margin,
            change_chunks,
        )
    })();
    finish(
        result.map(String::into_bytes),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

/// Pay any unbound transaction's DUST fee from this wallet, whoever built it. On `OK` the out-buffer
/// holds JSON `{"tx","state","fee","paid","segment","identifiers"}`.
///
/// Proves the K=13 dust spend circuit, merges the fee intent beside the caller's and seals, so it
/// takes artifact directories and costs real CPU.
///
/// # Safety
/// `dust_role_key` points to 32 bytes; `transaction` to `transaction_len` bytes of a tagged
/// `Transaction<SignatureEnabled, Proof, PreBinding>`; `dust_state` to `dust_state_len` bytes.
/// `artifact_dir` and `params_dir` are valid NUL-terminated C strings. Release `*out` / `*out_err`
/// via `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_wallet_pay_fee_from_dust(
    transaction: *const u8,
    transaction_len: usize,
    dust_state: *const u8,
    dust_state_len: usize,
    dust_role_key: *const u8,
    ctime_secs: u64,
    ttl_secs: u64,
    artifact_dir: *const c_char,
    params_dir: *const c_char,
    fee_margin: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if transaction.is_null()
        || dust_state.is_null()
        || dust_role_key.is_null()
        || artifact_dir.is_null()
        || params_dir.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = (|| {
        crate::fee::pay_fee_from_dust_hex(
            std::slice::from_raw_parts(transaction, transaction_len),
            std::slice::from_raw_parts(dust_state, dust_state_len),
            &*(dust_role_key as *const [u8; 32]),
            ctime_secs,
            ttl_secs,
            &path_arg(artifact_dir, "artifact dir")?,
            &path_arg(params_dir, "params dir")?,
            fee_margin,
        )
    })();
    finish(
        result.map(String::into_bytes),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

/// Fund the deficits of a transaction a dApp composed. On `OK` the out-buffer holds the funded,
/// signed, still-unbound transaction as hex.
///
/// No artifacts and no proving: the transaction arrives proven and only unshielded value is added.
///
/// # Safety
/// `night_role_key` points to 32 bytes; `transaction` to `transaction_len` bytes of a tagged
/// `Transaction<SignatureEnabled, Proof, PreBinding>`; `packed_inputs` to `packed_inputs_len` bytes of
/// 84-byte records. Release `*out` / `*out_err` via `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_wallet_balance_unsealed_transaction(
    transaction: *const u8,
    transaction_len: usize,
    night_role_key: *const u8,
    packed_inputs: *const u8,
    packed_inputs_len: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if transaction.is_null()
        || night_role_key.is_null()
        || packed_inputs.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = crate::balance::balance_unsealed_transaction_hex(
        std::slice::from_raw_parts(transaction, transaction_len),
        &*(night_role_key as *const [u8; 32]),
        std::slice::from_raw_parts(packed_inputs, packed_inputs_len),
    );
    finish(
        result.map(String::into_bytes),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

/// Reads that return JSON: `summary`, `tryDecrypt`, `txIdentifiers`, `txBalance`. Grouped by return
/// shape, not by subject — `txIdentifiers` and `txBalance` use neither the state nor the key, but a
/// separate export would cost six hand-written bridge halves. `tryDecrypt` yields `null` for an output
/// that is not ours — an answer, not a failure, so it must not be conflated with `ERR_FAILED`.
///
/// # Safety
/// As [`midnight_wallet_state_op`].
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_wallet_read_op(
    op: *const c_char,
    state: *const u8,
    state_len: usize,
    zswap_role_key: *const u8,
    arg: *const u8,
    arg_len: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if op.is_null()
        || state.is_null()
        || zswap_role_key.is_null()
        || arg.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = (|| {
        let op = path_arg(op, "wallet op")?;
        let mut key = [0u8; 32];
        key.copy_from_slice(std::slice::from_raw_parts(zswap_role_key, 32));
        crate::wallet::read_op(
            &op,
            std::slice::from_raw_parts(state, state_len),
            &key,
            std::slice::from_raw_parts(arg, arg_len),
        )
    })();
    finish(
        result.map(String::into_bytes),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

/// On `OK` the out-buffer holds JSON: a row object, or the four bytes `null` when that identity has
/// published nothing. As with resolve, `null` is a definite answer and must not be conflated with
/// `ERR_FAILED` — "nobody published this" is not "we could not look".
///
/// # Safety
/// `state` points to `state_len` readable bytes and `identity` to 32 readable bytes; the
/// out-pointers are writable. Release `*out` / `*out_err` via `midnight_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn midnight_identity_row(
    state: *const u8,
    state_len: usize,
    identity: *const u8,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if state.is_null()
        || identity.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let bytes = std::slice::from_raw_parts(state, state_len);
    let mut c = [0u8; 32];
    c.copy_from_slice(std::slice::from_raw_parts(identity, 32));
    let result = crate::identity::identity_row_json(bytes, c);
    finish(
        result.map(String::into_bytes),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

/// A member's merkle path out of a circle's contract state, `20 × 33` bytes.
///
/// # Safety
/// `state` readable for `state_len` bytes, `leaf` for 32; out-pointers writable. Release `*out` /
/// `*out_err` via `midnight_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn midnight_circle_member_path(
    state: *const u8,
    state_len: usize,
    leaf: *const u8,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if state.is_null()
        || leaf.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let bytes = std::slice::from_raw_parts(state, state_len);
    let mut member = [0u8; 32];
    member.copy_from_slice(std::slice::from_raw_parts(leaf, 32));
    finish(
        crate::circle::member_path(bytes, member),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

/// A moderator's merkle path out of a circle's contract state, `10 × 33` bytes.
///
/// Half the depth of a member path — `moderators` is a `HistoricMerkleTree<10, …>` — and the
/// distinction matters: a 20-entry path hashes to a root `requireModerator` does not match.
///
/// ⚠️ Without this, `setInvite` and `addModerator` could be *given* a moderator path and no caller
/// could *compute* one, which is why invite issuance had no rail despite every other layer existing.
///
/// # Safety
/// `state` readable for `state_len` bytes, `leaf` for 32; out-pointers writable. Release `*out` /
/// `*out_err` via `midnight_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn midnight_circle_moderator_path(
    state: *const u8,
    state_len: usize,
    leaf: *const u8,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if state.is_null()
        || leaf.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let bytes = std::slice::from_raw_parts(state, state_len);
    let mut moderator = [0u8; 32];
    moderator.copy_from_slice(std::slice::from_raw_parts(leaf, 32));
    finish(
        crate::circle::moderator_path(bytes, moderator),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

/// The root of a circle's members tree, little-endian — compared against a proposal's sealed root
/// before proving, so a wrong-height state fails with a reason instead of as a bad proof.
///
/// # Safety
/// `state` readable for `state_len` bytes; out-pointers writable.
#[no_mangle]
pub unsafe extern "C" fn midnight_circle_members_root(
    state: *const u8,
    state_len: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if state.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let bytes = std::slice::from_raw_parts(state, state_len);
    finish(
        crate::circle::members_root(bytes).map(|root| root.to_vec()),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

/// A circle's `inviteAuthority` commitment, or **zero bytes** when it has delegated to nobody.
///
/// The empty answer is the load-bearing part: "no delegation" and "we could not read the state" are
/// different facts, and only one of them means a founder should be shown a button that turns
/// delegation on. An error goes out through `out_err` as everywhere else, so a caller distinguishes
/// them by the return code rather than by an empty buffer.
///
/// # Safety
/// `state` readable for `state_len` bytes; out-pointers writable. Release `*out` / `*out_err` via
/// `midnight_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn midnight_circle_invite_authority(
    state: *const u8,
    state_len: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if state.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let bytes = std::slice::from_raw_parts(state, state_len);
    finish(
        crate::circle::invite_authority(bytes)
            .map(|authority| authority.map(|a| a.to_vec()).unwrap_or_default()),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

// `claimName` / `releaseName` were removed on 2026-08-24 when handles left `identity.compact` for a
// per-name contract. Their replacements are below: `bind` / `rebind`, which take a permit rather than
// a name and a flag — re-added rather than repointed, because the arguments differ.

/// Build a proven-unbound `claimFreePermit` transaction — a tier permit out of the free tier.
///
/// Needs no unshielded input of its own: the call spends nothing, so the sponsor's fee segment is all
/// it takes to submit. `tier` is 0..=6.
///
/// # Safety
/// Pointers are readable for their stated lengths (`contract_address` / `recipient` are 32 bytes); the
/// out-pointers are writable. Release `*out` / `*out_err` via `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_claim_free_permit_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    tier: u8,
    recipient: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || recipient.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            crate::preimage::build_claim_free_permit_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                tier,
                *(recipient as *const [u8; 32]),
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// Build a proven-unbound `bind` transaction — claim a handle.
///
/// ⚠️ The result **does not balance**: `bind` spends a tier permit, so the caller adds that UTxO as an
/// unshielded input. A permit is an ordinary ledger UTxO, so funding it is the wallet's job.
///
/// # Safety
/// Pointers are readable for their stated lengths (`contract_address` / `identity_sk` are 32 bytes);
/// the out-pointers are writable. Release `*out` / `*out_err` via `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_bind_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    identity_sk: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || identity_sk.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            crate::preimage::build_bind_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                *(identity_sk as *const [u8; 32]),
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// Build a proven-unbound `rebind` transaction — hand a handle to another identity.
///
/// # Safety
/// As [`midnight_build_bind_proven_tx`], plus `new_owner` readable for 32 bytes.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_rebind_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    new_owner: *const u8,
    identity_sk: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || new_owner.is_null()
        || identity_sk.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            crate::preimage::build_rebind_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                *(new_owner as *const [u8; 32]),
                *(identity_sk as *const [u8; 32]),
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// The address a handle contract deploys to — a pure derivation over the canonical name.
///
/// No proving, no network: hash the name, get the address, ask the indexer whether anything is there.
///
/// # Safety
/// `name` / `payment` readable for 32 bytes each; out-pointers writable.
#[no_mangle]
pub unsafe extern "C" fn midnight_handle_address(
    keys_dir: *const c_char,
    name: *const u8,
    payment: *const u8,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if name.is_null()
        || payment.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = path_arg(keys_dir, "keys dir").and_then(|dir| {
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::HANDLE_ENTRY_POINTS)?;
        crate::deploy::handle_deploy_address(
            *(name as *const [u8; 32]),
            *(payment as *const [u8; 32]),
            &keys,
        )
        .map(|a| a.to_vec())
    });
    finish(result, out, out_len, out_err, out_err_len)
}

/// The address an identity contract deploys to — a pure derivation over `C`.
///
/// # Safety
/// `c` readable for 32 bytes; out-pointers writable.
#[no_mangle]
pub unsafe extern "C" fn midnight_identity_address(
    keys_dir: *const c_char,
    c: *const u8,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if c.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = path_arg(keys_dir, "keys dir").and_then(|dir| {
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::IDENTITY_ENTRY_POINTS)?;
        crate::deploy::identity_deploy_address(*(c as *const [u8; 32]), &keys).map(|a| a.to_vec())
    });
    finish(result, out, out_len, out_err, out_err_len)
}

/// An unproven, unbalanced identity-shell deploy. Returns `address ‖ tx`.
///
/// The shell has to exist before a row can be published into it — one contract per identity
/// (`docs/BOUNDED_STATE_ARCHITECTURE.md` §1), so this is the first transaction any new identity makes.
///
/// # Safety
/// `c` readable for 32 bytes; out-pointers writable. Release `*out` / `*out_err` via
/// `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_identity_deploy_tx(
    keys_dir: *const c_char,
    c: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if c.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = path_arg(keys_dir, "keys dir").and_then(|dir| {
        let network = path_arg(network_id, "network id")?;
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::IDENTITY_ENTRY_POINTS)?;
        let (tx, address) = crate::deploy::build_identity_deploy_tx(
            *(c as *const [u8; 32]),
            &keys,
            &network,
            ttl_secs,
        )?;
        let mut out = address.to_vec();
        out.extend_from_slice(&tx);
        Ok(out)
    });
    finish(result, out, out_len, out_err, out_err_len)
}

/// An unproven, unbalanced handle-shell deploy. Returns `address ‖ tx`.
///
/// # Safety
/// `name` / `payment` readable for 32 bytes each; out-pointers writable.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_handle_deploy_tx(
    keys_dir: *const c_char,
    name: *const u8,
    payment: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if name.is_null()
        || payment.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = path_arg(keys_dir, "keys dir").and_then(|dir| {
        let network = path_arg(network_id, "network id")?;
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::HANDLE_ENTRY_POINTS)?;
        let (tx, address) = crate::deploy::build_handle_deploy_tx(
            *(name as *const [u8; 32]),
            *(payment as *const [u8; 32]),
            &keys,
            &network,
            ttl_secs,
        )?;
        let mut out = address.to_vec();
        out.extend_from_slice(&tx);
        Ok(out)
    });
    finish(result, out, out_len, out_err, out_err_len)
}

/// Build a proven-unbound `setPrimaryName` transaction.
///
/// # Safety
/// Pointers are readable for their stated lengths (`name`/`contract_address`/`identity_sk` are 32
/// bytes); the out-pointers are writable. Release `*out` / `*out_err` via `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_set_primary_name_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    name: *const u8,
    identity_sk: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || name.is_null()
        || identity_sk.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            crate::preimage::build_set_primary_name_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                *(name as *const [u8; 32]),
                *(identity_sk as *const [u8; 32]),
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// Build a proven-unbound `setRow` transaction — one contact-card row.
///
/// `value` is the full 320-byte row field; kind 0 clears the slot.
///
/// # Safety
/// `value` is readable for 320 bytes, `contract_address`/`identity_sk` for 32; the out-pointers are
/// writable. Release `*out` / `*out_err` via `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_set_row_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    slot: u8,
    kind: u8,
    value: *const u8,
    identity_sk: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || value.is_null()
        || identity_sk.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let row = std::slice::from_raw_parts(value, 320);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            crate::preimage::build_set_row_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                slot,
                kind,
                row,
                *(identity_sk as *const [u8; 32]),
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// Build a proven-unbound `setRows` transaction — exactly four slots, the template's fixed width.
///
/// `slots` and `kinds` are four bytes each; `values` is the four 320-byte rows concatenated.
///
/// # Safety
/// `slots`/`kinds` are readable for 4 bytes, `values` for 1280, `contract_address`/`identity_sk` for
/// 32; the out-pointers are writable. Release `*out` / `*out_err` via `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_set_rows_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    slots: *const u8,
    kinds: *const u8,
    values: *const u8,
    identity_sk: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || slots.is_null()
        || kinds.is_null()
        || values.is_null()
        || identity_sk.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let slot_bytes = std::slice::from_raw_parts(slots, 4);
    let kind_bytes = std::slice::from_raw_parts(kinds, 4);
    let flat = std::slice::from_raw_parts(values, 4 * 320);
    let writes: Vec<crate::preimage::CardWrite> = (0..4)
        .map(|i| crate::preimage::CardWrite {
            slot: slot_bytes[i],
            kind: kind_bytes[i],
            value: flat[i * 320..(i + 1) * 320].to_vec(),
        })
        .collect();
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            crate::preimage::build_set_rows_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                &writes,
                *(identity_sk as *const [u8; 32]),
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// Resolve a handle to the `C` that holds it: 64 hex characters, or an empty buffer when the handle
/// is unclaimed. The caller must label the peer from that `C`'s row rather than from the handle it
/// passed in — see [`crate::identity::name_owner`].
///
/// # Safety
/// `state`/`name` point to `state_len`/32 readable bytes; the out-pointers are writable. Release
/// `*out` / `*out_err` via `midnight_buffer_free`.
#[no_mangle]
pub unsafe extern "C" fn midnight_name_owner(
    state: *const u8,
    state_len: usize,
    name: *const u8,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if state.is_null()
        || name.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let bytes = std::slice::from_raw_parts(state, state_len);
    let mut handle = [0u8; 32];
    handle.copy_from_slice(std::slice::from_raw_parts(name, 32));
    let result = crate::identity::name_owner_hex(bytes, handle);
    finish(
        result.map(String::into_bytes),
        out,
        out_len,
        out_err,
        out_err_len,
    )
}

/// Build a proven-unbound `publishIdentityRow` transaction on-device (iOS side of the bridge).
///
/// # Safety
/// Path pointers are valid NUL-terminated C strings; `contract_state` points to
/// `contract_state_len` readable bytes; `contract_address`/`anchor`/`auth_pub`/`identity_sk`
/// each point to 32 readable bytes; the out-pointers are writable. Release buffers with
/// `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_publish_row_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    anchor: *const u8,
    auth_pub: *const u8,
    identity_sk: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || anchor.is_null()
        || auth_pub.is_null()
        || identity_sk.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            crate::preimage::build_publish_row_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                *(anchor as *const [u8; 32]),
                *(auth_pub as *const [u8; 32]),
                *(identity_sk as *const [u8; 32]),
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

// ── Circle deploy (crate::deploy) ──
//
// Creating a circle is a deploy, not a call, so there is no proving here and no per-circuit
// artifacts — only the entry points' verifier keys, read from a directory. Two entry points rather
// than one returning a pair, so each still returns a single buffer like every other export.

/// Build the unproven, unbalanced deploy transaction for a circle. `keys_dir` holds
/// `<entryPoint>.verifier` for every circuit; `circle_id`, `founder` and `founder_auth` point to 32
/// bytes each; `is_open` is 0/1.
///
/// `founder_auth` is the auth key the constructor seats in `moderatorAuth` for the founder, and
/// `founder_joined` is their `identityJoinNullifier`, seated beside the member leaf. Both feed the
/// initial state and therefore the **address**, so a caller passing different bytes gets a different
/// circle rather than the same one.
///
/// # Safety
/// `keys_dir`/`network_id` are valid NUL-terminated C strings; `circle_id`, `founder`,
/// `founder_auth` and `founder_joined` point to 32 readable bytes each; the out-pointers are
/// writable. The returned buffer is released with `midnight_buffer_free`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_circle_deploy_tx(
    keys_dir: *const c_char,
    circle_id: *const u8,
    is_open: u8,
    founder: *const u8,
    founder_auth: *const u8,
    founder_joined: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if keys_dir.is_null()
        || circle_id.is_null()
        || founder.is_null()
        || founder_auth.is_null()
        || founder_joined.is_null()
        || network_id.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = (|| {
        let dir = path_arg(keys_dir, "verifier key directory")?;
        let network = path_arg(network_id, "network id")?;
        let keys = crate::deploy::read_circle_verifier_keys(&dir)?;
        crate::deploy::build_circle_deploy_tx(
            *(circle_id as *const [u8; 32]),
            is_open != 0,
            *(founder as *const [u8; 32]),
            *(founder_auth as *const [u8; 32]),
            *(founder_joined as *const [u8; 32]),
            &keys,
            &network,
            ttl_secs,
        )
        .map(|(bytes, _address)| bytes)
    })();
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// The address a circle's constructor arguments imply, without building a transaction — so a client
/// can check that an address it was handed is the one those arguments produce.
///
/// # Safety
/// As `midnight_build_circle_deploy_tx`. On `OK` the out-buffer holds exactly 32 bytes.
#[no_mangle]
pub unsafe extern "C" fn midnight_circle_deploy_address(
    keys_dir: *const c_char,
    circle_id: *const u8,
    is_open: u8,
    founder: *const u8,
    founder_auth: *const u8,
    founder_joined: *const u8,
    out_address: *mut *mut u8,
    out_address_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if keys_dir.is_null()
        || circle_id.is_null()
        || founder.is_null()
        || founder_auth.is_null()
        || founder_joined.is_null()
        || out_address.is_null()
        || out_address_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = (|| {
        let dir = path_arg(keys_dir, "verifier key directory")?;
        let keys = crate::deploy::read_circle_verifier_keys(&dir)?;
        crate::deploy::circle_deploy_address(
            *(circle_id as *const [u8; 32]),
            is_open != 0,
            *(founder as *const [u8; 32]),
            *(founder_auth as *const [u8; 32]),
            *(founder_joined as *const [u8; 32]),
            &keys,
        )
        .map(|address| address.to_vec())
    })();
    finish(result, out_address, out_address_len, out_err, out_err_len)
}

/// Build a proven-unbound `castVote` transaction on-device.
///
/// The member path is a **parameter**, not read from state: a proposal seals its electorate and holds
/// no tree, so the caller supplies the path as of the sealed root — 20 x (32-byte little-endian
/// sibling, 1 byte `goes_left`) = 660 bytes.
///
/// # Safety
/// `contract_state` readable for `contract_state_len`; `contract_address` / `persona_sk` /
/// `ballot_rand` for 32 bytes each; `member_path` for `member_path_len`; out-pointers writable.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_cast_vote_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    persona_sk: *const u8,
    ballot_option: u8,
    ballot_rand: *const u8,
    member_path: *const u8,
    member_path_len: usize,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || persona_sk.is_null()
        || ballot_rand.is_null()
        || member_path.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let path_bytes = std::slice::from_raw_parts(member_path, member_path_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            let path = crate::preimage::member_path_from_bytes(path_bytes)?;
            crate::preimage::build_cast_vote_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                *(persona_sk as *const [u8; 32]),
                ballot_option,
                *(ballot_rand as *const [u8; 32]),
                &path,
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// Build a proven-unbound `setInvite` transaction on-device — issue (`active`) or revoke.
///
/// The moderator path is a **parameter** like `castVote`'s member path, but half the length: the
/// `moderators` tree is `HistoricMerkleTree<10, …>`, so 10 x (32-byte little-endian sibling, 1 byte
/// `goes_left`) = 330 bytes. A 660-byte member path decodes fine here and hashes to a root that
/// matches nothing, which the circuit reports as "not a moderator" — hence the depth-checked decoder.
///
/// # Safety
/// `contract_state` readable for `contract_state_len`; `contract_address` / `persona_sk` /
/// `commitment` for 32 bytes each; `moderator_path` for `moderator_path_len`; out-pointers writable.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_set_invite_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    persona_sk: *const u8,
    moderator_path: *const u8,
    moderator_path_len: usize,
    commitment: *const u8,
    active: bool,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || persona_sk.is_null()
        || moderator_path.is_null()
        || commitment.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let path_bytes = std::slice::from_raw_parts(moderator_path, moderator_path_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            let path = crate::preimage::moderator_path_from_bytes(path_bytes)?;
            crate::preimage::build_set_invite_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                *(persona_sk as *const [u8; 32]),
                &path,
                *(commitment as *const [u8; 32]),
                active,
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// Build a proven-unbound `issueInvite` transaction on-device — the delegated authority's issuance.
///
/// **No Merkle path at all**, unlike every other privileged circuit here: the authority is a
/// commitment in a ledger cell rather than a leaf in `moderators`, so there is nothing to compute a
/// path against. A caller holding the wrong secret — or a circle that delegated to nobody — is
/// refused by the builder with a named error before any proving happens.
///
/// # Safety
/// `contract_state` readable for `contract_state_len`; `authority_sk` / `commitment` /
/// `contract_address` for 32 bytes each; out-pointers writable.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_issue_invite_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    authority_sk: *const u8,
    commitment: *const u8,
    active: bool,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || authority_sk.is_null()
        || commitment.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            crate::preimage::build_issue_invite_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                *(authority_sk as *const [u8; 32]),
                *(commitment as *const [u8; 32]),
                active,
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// Build a proven-unbound `setInviteAuthority` transaction on-device — delegate, rotate, or withdraw.
///
/// Moderator-gated, so the moderator path is a 330-byte parameter as in
/// `midnight_build_set_invite_proven_tx`. 32 zero bytes in `authority` withdraws the delegation.
///
/// # Safety
/// As `midnight_build_set_invite_proven_tx`, with `authority` readable for 32 bytes in place of
/// `commitment`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_set_invite_authority_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    persona_sk: *const u8,
    moderator_path: *const u8,
    moderator_path_len: usize,
    authority: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || persona_sk.is_null()
        || moderator_path.is_null()
        || authority.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let path_bytes = std::slice::from_raw_parts(moderator_path, moderator_path_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            let path = crate::preimage::moderator_path_from_bytes(path_bytes)?;
            crate::preimage::build_set_invite_authority_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                *(persona_sk as *const [u8; 32]),
                &path,
                *(authority as *const [u8; 32]),
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// Serve one Compact-runtime leaf for the compactc-generated JS driver.
///
/// One dispatcher rather than eleven exports: op and arguments are JSON in, JSON out, so the bridge
/// tax is paid once however many leaves `compact.rs` grows.
///
/// # Safety
/// `op` and `args` must be NUL-terminated UTF-8; the out pointers as `midnight_circle_member_path`.
#[no_mangle]
pub unsafe extern "C" fn midnight_compact_op(
    op: *const c_char,
    args: *const c_char,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if op.is_null() || args.is_null() || out.is_null() || out_len.is_null() || out_err.is_null() || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = path_arg(op, "compact op")
        .and_then(|op| path_arg(args, "compact args").map(|args| (op, args)))
        .and_then(|(op, args)| crate::compact::compact_op(&op, &args))
        .map(|json| json.into_bytes());
    finish(result, out, out_len, out_err, out_err_len)
}

/// Build a proven-unbound `leaveCircle` transaction on-device — remove your own leaf.
///
/// ⚠️ **One-way.** Nothing releases the join nullifier, so a leaver can never rejoin this circle.
///
/// # Safety
/// As `midnight_build_set_invite_proven_tx`, with `member_path` readable for `member_path_len` and
/// no commitment argument.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_leave_circle_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    persona_sk: *const u8,
    member_path: *const u8,
    member_path_len: usize,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || persona_sk.is_null()
        || member_path.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let path_bytes = std::slice::from_raw_parts(member_path, member_path_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            let path = crate::preimage::member_path_from_bytes(path_bytes)?;
            crate::preimage::build_leave_circle_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                *(persona_sk as *const [u8; 32]),
                &path,
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// Build a proven-unbound `addModerator` transaction on-device.
///
/// Two paths, and they are different heights: the caller's moderator path (330 bytes) and the target's
/// member path (660). Passing them the wrong way round decodes as a length error rather than as a
/// silent wrong root, which is the reason the decoders are depth-checked rather than length-inferred.
///
/// # Safety
/// As `midnight_build_set_invite_proven_tx`, plus `member_path` readable for `member_path_len` and
/// `target_leaf` / `auth_pub` for 32 bytes each.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_add_moderator_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    persona_sk: *const u8,
    moderator_path: *const u8,
    moderator_path_len: usize,
    target_leaf: *const u8,
    member_path: *const u8,
    member_path_len: usize,
    auth_pub: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || persona_sk.is_null()
        || moderator_path.is_null()
        || target_leaf.is_null()
        || member_path.is_null()
        || auth_pub.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let mod_bytes = std::slice::from_raw_parts(moderator_path, moderator_path_len);
    let member_bytes = std::slice::from_raw_parts(member_path, member_path_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            let mod_path = crate::preimage::moderator_path_from_bytes(mod_bytes)?;
            let member = crate::preimage::member_path_from_bytes(member_bytes)?;
            crate::preimage::build_add_moderator_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                *(persona_sk as *const [u8; 32]),
                &mod_path,
                *(target_leaf as *const [u8; 32]),
                &member,
                *(auth_pub as *const [u8; 32]),
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// Build a proven-unbound `revealVote` transaction on-device. No member path — the nullifier already
/// proves this persona voted while an elector.
///
/// # Safety
/// As `midnight_build_cast_vote_proven_tx`, without the path arguments.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_reveal_vote_proven_tx(
    zkir_path: *const c_char,
    prover_key_path: *const c_char,
    verifier_key_path: *const c_char,
    params_path: *const c_char,
    contract_state: *const u8,
    contract_state_len: usize,
    contract_address: *const u8,
    persona_sk: *const u8,
    ballot_option: u8,
    ballot_rand: *const u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out_tx: *mut *mut u8,
    out_tx_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if contract_state.is_null()
        || contract_address.is_null()
        || persona_sk.is_null()
        || ballot_rand.is_null()
        || out_tx.is_null()
        || out_tx_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let state = std::slice::from_raw_parts(contract_state, contract_state_len);
    let result = read_artifacts(zkir_path, prover_key_path, verifier_key_path, params_path)
        .and_then(|(zkir, prover_key, verifier_key, params)| {
            let network = path_arg(network_id, "network id")?;
            crate::preimage::build_reveal_vote_proven_tx(
                state,
                *(contract_address as *const [u8; 32]),
                *(persona_sk as *const [u8; 32]),
                ballot_option,
                *(ballot_rand as *const [u8; 32]),
                &zkir,
                &prover_key,
                &verifier_key,
                &params,
                &network,
                ttl_secs,
            )
        });
    finish(result, out_tx, out_tx_len, out_err, out_err_len)
}

/// The address a proposal deploys to — a pure derivation over `(circleId, content)` plus the sealed
/// electorate. No proving, no network.
///
/// `members_root` crosses as 32 little-endian bytes.
///
/// # Safety
/// `circle_id` / `members_root` / `content` / `author` readable for 32 bytes each; out-pointers
/// writable.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_proposal_address(
    keys_dir: *const c_char,
    circle_id: *const u8,
    members_root: *const u8,
    content: *const u8,
    author: *const u8,
    option_count: u8,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if circle_id.is_null()
        || members_root.is_null()
        || content.is_null()
        || author.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = path_arg(keys_dir, "keys dir").and_then(|dir| {
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::PROPOSAL_ENTRY_POINTS)?;
        let root = fr_from_le(&*(members_root as *const [u8; 32]))?;
        crate::deploy::proposal_deploy_address(
            *(circle_id as *const [u8; 32]),
            root,
            *(content as *const [u8; 32]),
            *(author as *const [u8; 32]),
            option_count,
            &keys,
        )
        .map(|a| a.to_vec())
    });
    finish(result, out, out_len, out_err, out_err_len)
}

/// An unproven, unbalanced proposal deploy. Returns `address ‖ tx`, so a caller never has to trust
/// anyone else's answer to which contract it creates.
///
/// # Safety
/// As `midnight_proposal_address`, plus a network id.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn midnight_build_proposal_deploy_tx(
    keys_dir: *const c_char,
    circle_id: *const u8,
    members_root: *const u8,
    content: *const u8,
    author: *const u8,
    option_count: u8,
    network_id: *const c_char,
    ttl_secs: u64,
    out: *mut *mut u8,
    out_len: *mut usize,
    out_err: *mut *mut u8,
    out_err_len: *mut usize,
) -> i32 {
    if circle_id.is_null()
        || members_root.is_null()
        || content.is_null()
        || author.is_null()
        || out.is_null()
        || out_len.is_null()
        || out_err.is_null()
        || out_err_len.is_null()
    {
        return ERR_NULL;
    }
    let result = path_arg(keys_dir, "keys dir").and_then(|dir| {
        let network = path_arg(network_id, "network id")?;
        let keys = crate::deploy::read_verifier_keys(&dir, &crate::deploy::PROPOSAL_ENTRY_POINTS)?;
        let root = fr_from_le(&*(members_root as *const [u8; 32]))?;
        let (tx, address) = crate::deploy::build_proposal_deploy_tx(
            *(circle_id as *const [u8; 32]),
            root,
            *(content as *const [u8; 32]),
            *(author as *const [u8; 32]),
            option_count,
            &keys,
            &network,
            ttl_secs,
        )?;
        let mut out = address.to_vec();
        out.extend_from_slice(&tx);
        Ok(out)
    });
    finish(result, out, out_len, out_err, out_err_len)
}
