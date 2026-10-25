//! Exports for the Cloudflare Worker build (`wasm32-unknown-unknown`, `--no-default-features`).
//!
//! Deliberately hand-rolled rather than `wasm-bindgen`: the surface is one function, and a generated
//! glue layer would add a dependency to a crate the *device* also builds, plus a generated-output
//! directory to keep in sync. The ABI here mirrors [`crate::c_bridge`]'s shape — one call, one
//! caller-freed buffer — so the two read the same way.
//!
//! **Buffer contract.** Every result is a single allocation: byte 0 is the status (`0` = ok, `1` =
//! error), the rest is UTF-8 — the row JSON (or the literal `null` for an unpublished identity) on
//! success, the failure message on error. The caller reads `*out_len` for the total length and
//! returns the buffer through [`pnyx_dealloc`]. Errors travel in-band because a null return would
//! lose the reason, and "we could not look" must stay distinguishable from "nobody published this".
//!
//! ⚠️ The Worker profile sets `panic = "abort"`, so a panic traps the instance rather than
//! unwinding. Every reachable failure in [`crate::identity::identity_row`] is an `Err`, and
//! malformed-state input is covered by its tests, but a panic inside the midnight crates would
//! surface as a 500 and a fresh isolate rather than a caught error.

use crate::identity::identity_row_json;
use alloc::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};

extern crate alloc;

/// Refuse randomness rather than import a JS backend for it.
///
/// `getrandom` 0.2 reaches this build transitively (midnight-curves → … → onchain-runtime) and its
/// default wasm32 backend is wasm-bindgen-based, which would put `__wbindgen_placeholder__` imports
/// in a module whose only job is to decode bytes. Decoding never draws randomness, so the handler
/// errors — loudly, if some future path here ever needs it — instead of returning zeros, which is
/// the failure mode that matters for anything cryptographic.
fn randomness_unavailable(_dest: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
getrandom::register_custom_getrandom!(randomness_unavailable);

/// A byte buffer the caller will fill and hand back to us. `len == 0` yields a dangling-but-aligned
/// pointer rather than a null, so the caller never has to special-case an empty payload.
#[no_mangle]
pub extern "C" fn pnyx_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::NonNull::<u8>::dangling().as_ptr();
    }
    // align 1: every buffer crossing this ABI is bytes.
    let layout = Layout::from_size_align(len, 1).expect("byte layout");
    unsafe { raw_alloc(layout) }
}

/// Release a buffer from [`pnyx_alloc`] or a result buffer from [`pnyx_identity_row`].
///
/// # Safety
/// `ptr`/`len` must be exactly what the allocation returned.
#[no_mangle]
pub unsafe extern "C" fn pnyx_dealloc(ptr: *mut u8, len: usize) {
    if len == 0 || ptr.is_null() {
        return;
    }
    raw_dealloc(ptr, Layout::from_size_align(len, 1).expect("byte layout"));
}

fn finish(status: u8, body: &str, out_len: *mut usize) -> *mut u8 {
    let mut buffer = alloc::vec::Vec::with_capacity(1 + body.len());
    buffer.push(status);
    buffer.extend_from_slice(body.as_bytes());
    let boxed = buffer.into_boxed_slice();
    let len = boxed.len();
    // SAFETY: `out_len` is a writable usize the caller reserved.
    unsafe { *out_len = len };
    alloc::boxed::Box::into_raw(boxed) as *mut u8
}

/// One identity row from serialized contract state.
///
/// # Safety
/// `state` points to `state_len` readable bytes, `identity` to 32 readable bytes, and `out_len` to a
/// writable `usize`.
#[no_mangle]
pub unsafe extern "C" fn pnyx_identity_row(
    state: *const u8,
    state_len: usize,
    identity: *const u8,
    out_len: *mut usize,
) -> *mut u8 {
    if state.is_null() || identity.is_null() || out_len.is_null() {
        return finish(1, "null argument", out_len);
    }
    let bytes = core::slice::from_raw_parts(state, state_len);
    let mut c = [0u8; 32];
    c.copy_from_slice(core::slice::from_raw_parts(identity, 32));
    match identity_row_json(bytes, c) {
        Ok(json) => finish(0, &json, out_len),
        Err(message) => finish(1, &message, out_len),
    }
}

/// A contract's code digest — what recognises an identity contract without knowing its address.
///
/// The Worker cannot derive the address (that needs the deploy machinery this build excludes), so a
/// login carries the address and this is how the state found there is checked to be built from *our*
/// identity template. Combined with `identity_row`'s sealed-`id` check that is sufficient: `publishRow`
/// proves knowledge of `identitySk`, so a template-conforming contract sealed to `C` can only ever hold
/// `C`'s own row, and anybody else's copy of it stays empty.
///
/// # Safety
/// `state` points to `state_len` readable bytes and `out_len` to a writable `usize`.
#[no_mangle]
pub unsafe extern "C" fn pnyx_contract_code_digest(
    state: *const u8,
    state_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if state.is_null() || out_len.is_null() {
        return finish(1, "null argument", out_len);
    }
    let bytes = core::slice::from_raw_parts(state, state_len);
    match crate::identity::code_digest(bytes) {
        Ok(digest) => finish(0, &digest, out_len),
        Err(message) => finish(1, &message, out_len),
    }
}
