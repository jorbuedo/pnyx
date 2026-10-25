//! Domain-separated derivations shared by the circuits and by the readers over their state.
//!
//! **Why they are not in `preimage`.** They were, and `payment` — a plain state reader — imported them
//! from there. `preimage` is gated behind `proving`, so the **decode-only Worker build broke**: an
//! ungated module reaching into a gated one does not compile with `--no-default-features --features
//! worker`, which is exactly what `services/content/scripts/build-wasm.sh` runs. The committed
//! `identity-row.wasm` predated that import, so nothing caught it until the script was next run.
//!
//! These are pure hashes over byte tags — `persistent_hash` is SHA-256 from `midnight-base-crypto`,
//! which a decode-only build already links — so there is no reason for them to sit behind proving.
//!
//! ⚠️ **One copy, deliberately.** The storefront probes the same `prices` keys the circuit asserts; two
//! implementations of this hash would let a UI say "free" about a row `claimFreePermit` cannot find.

use midnight_base_crypto::hash::persistent_hash;

/// Domain-separation tags, each a compact `Bytes<32>`: the ASCII label right-padded with zeros.
pub fn domain(label: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..label.len()].copy_from_slice(label);
    out
}

/// The permit colour a free claim mints and spends.
pub fn free_color() -> [u8; 32] {
    domain(b"pnyx:free")
}

/// The per-tier domain a permit is separated by. Tiers above the table share the top bucket, which is
/// what `nameTier` does in-circuit.
pub fn permit_domain(tier: u8) -> [u8; 32] {
    match tier {
        0 => domain(b"pnyx:permit:t0"),
        1 => domain(b"pnyx:permit:t1"),
        2 => domain(b"pnyx:permit:t2"),
        3 => domain(b"pnyx:permit:t3"),
        4 => domain(b"pnyx:permit:t4"),
        5 => domain(b"pnyx:permit:t5"),
        _ => domain(b"pnyx:permit:t6"),
    }
}

/// `priceKey(tier, colour)` — what `prices` is keyed by.
pub fn price_key(tier: u8, colour: [u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(96);
    input.extend_from_slice(&domain(b"pnyx:price"));
    input.extend_from_slice(&permit_domain(tier));
    input.extend_from_slice(&colour);
    persistent_hash(&input).0
}
