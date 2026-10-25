//! Reads over `payment.compact`'s state — which tiers are obtainable, and in what currency.
//!
//! The storefront's whole question. `prices` is a `Map<Bytes<32>, Uint<128>>` keyed by
//! `priceKey(tier, colour)`, so a client cannot enumerate the currencies a tier accepts: the key is a
//! hash, and recovering a colour from one is the hash's job to prevent. What it *can* do is probe a
//! colour it already knows, which is exactly the shape a storefront needs — "is this tier free, and if
//! not, what does it cost in the currency I hold".
//!
//! ⚠️ **A free row's amount is meaningless.** `claimFreePermit` asserts the row is *present* and never
//! reads it, so `setPrice(tier, freeColor(), 1)` opens a giveaway and the 1 is a placeholder. Reporting
//! it as a price would be inventing one.
//!
//! Rides `walletReadOp` rather than costing six hand-written bridge halves: no paths, no key, JSON out
//! — the same grouping `txIdentifiers` and the `dust:` reads use.

use midnight_onchain_runtime::state::{ContractState, StateValue};
use midnight_serialize::tagged_deserialize;

use crate::derivations::{free_color, price_key};
use crate::state_read::{bytes32, field, DB};

/// `prices` — slot 3 of `payment.compact`, in ledger declaration order.
///
/// Positional, like every slot index in this crate: adding a ledger field above it moves this, and the
/// failure is a read that finds a map full of keys it does not recognise rather than an error.
pub const PRICES_SLOT: u8 = 3;

/// The tiers `handle.compact` recognises. Tier 0 is the most expensive name, tier 6 the longest.
const TIERS: [u8; 7] = [0, 1, 2, 3, 4, 5, 6];

/// What one tier costs, from the chain's own state.
#[derive(Debug, PartialEq, Eq)]
pub struct TierOffer {
    pub tier: u8,
    /// A row exists under the reserved free colour — the tier is a giveaway.
    pub free: bool,
    /// The amount the probed colour's row names, if there is one. `None` means the tier does not
    /// accept that currency, which is not the same as "is free".
    pub price: Option<u128>,
}

/// Every tier's availability, probing `currency` for a priced row alongside the free one.
///
/// `currency` of `None` reports only what is free. NIGHT's colour is 32 zero bytes, so a caller asking
/// about NIGHT passes exactly that rather than an absence.
pub fn tier_offers(
    state_bytes: &[u8],
    currency: Option<[u8; 32]>,
) -> Result<Vec<TierOffer>, String> {
    let state: ContractState<DB> = tagged_deserialize(&mut &state_bytes[..])
        .map_err(|e| format!("deserialize payment state: {e}"))?;
    let StateValue::Map(ref prices) = field(&state, PRICES_SLOT as usize)? else {
        return Err(format!("ledger field {PRICES_SLOT} (prices) is not a map"));
    };

    // Matched key-first against what the map holds, rather than looking each key up. A direct lookup
    // would mean building an `AlignedValue` whose trailing zeros are trimmed exactly as the runtime
    // trimmed the stored one — a hash ending in `0x00` is rare enough to pass every test and fail in
    // the field. The map holds one row per (tier, currency) and is tiny, so iterating costs nothing.
    let free = free_color();
    let mut offers: Vec<TierOffer> = TIERS
        .iter()
        .map(|&tier| TierOffer {
            tier,
            free: false,
            price: None,
        })
        .collect();

    for entry in prices.iter() {
        let (key, value) = &*entry;
        let raw = match key.value.0.first() {
            Some(atom) => atom.0.as_slice(),
            None => &[][..],
        };
        let stored = bytes32(raw, "price key")?;
        for offer in offers.iter_mut() {
            if stored == price_key(offer.tier, free) {
                offer.free = true;
            } else if let Some(colour) = currency {
                if stored == price_key(offer.tier, colour) {
                    offer.price = Some(decode_u128(value)?);
                }
            }
        }
    }
    Ok(offers)
}

/// A `Uint<128>` cell back to a number. Little-endian with trailing zeros dropped, so an empty atom is
/// zero — and a zero-amount row is a real state: `setPrice(tier, colour, 0)` is how a row is removed,
/// so reading one back means the caller raced a removal.
fn decode_u128(value: &StateValue<DB>) -> Result<u128, String> {
    let StateValue::Cell(ref cell) = *value else {
        return Err("a price row is not a cell".to_string());
    };
    let atom = match cell.value.0.first() {
        Some(a) => a.0.as_slice(),
        None => &[][..],
    };
    if atom.len() > 16 {
        return Err(format!(
            "a price is {} bytes, expected at most 16",
            atom.len()
        ));
    }
    let mut le = [0u8; 16];
    le[..atom.len()].copy_from_slice(atom);
    Ok(u128::from_le_bytes(le))
}

/// `payment:` reads, for the `walletReadOp` dispatcher.
///
/// `arg` is the currency colour to probe: empty for none, 32 bytes otherwise. A decimal string carries
/// the price because a `Uint<128>` exceeds what JSON numbers hold exactly — the same reason
/// `dust:balance` reports SPECK as a string.
pub fn read_op(op: &str, state: &[u8], arg: &[u8]) -> Result<String, String> {
    match op {
        "payment:tiers" => {
            let currency = match arg.len() {
                0 => None,
                32 => Some(bytes32(arg, "currency colour")?),
                n => return Err(format!("a currency colour is 32 bytes, got {n}")),
            };
            let rows: Vec<String> = tier_offers(state, currency)?
                .iter()
                .map(|o| {
                    let price = match o.price {
                        Some(p) => format!("\"{p}\""),
                        None => "null".to_string(),
                    };
                    format!(
                        "{{\"tier\":{},\"free\":{},\"price\":{}}}",
                        o.tier, o.free, price
                    )
                })
                .collect();
            Ok(format!("{{\"tiers\":[{}]}}", rows.join(",")))
        }
        other => Err(format!("unknown payment read op: {other}")),
    }
}
