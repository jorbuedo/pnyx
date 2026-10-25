/**
 * The wire shape of the payment contract's tier reads.
 *
 * Pure and separate from `index.ts` so it can be tested without the native module — the parse is where
 * a malformed answer has to be caught, and that is exactly what a test can reach.
 *
 * @module
 */

/** What one price tier costs, as the chain reports it. */
export type TierOffer = {
  readonly tier: number
  /**
   * A row exists under the reserved free colour, so the tier is a giveaway.
   *
   * ⚠️ Independent of {@link TierOffer.price}: a tier can be free, priced, both or neither. Free is
   * not a price of zero — `setPrice(tier, colour, 0)` *removes* a row, so a zero could never mean free.
   */
  readonly free: boolean
  /**
   * What the probed currency costs, or `null` when that currency has no row for this tier.
   *
   * `null` means "this tier does not accept that currency" — never "free", and never zero. A `bigint`
   * because the ledger field is `Uint<128>`.
   */
  readonly price: bigint | null
}

/**
 * Parse `payment:tiers`.
 *
 * The price arrives as a decimal string because a `Uint<128>` exceeds what a JSON number holds
 * exactly — the same reason `dust:balance` reports SPECK as a string.
 */
export const parseTierOffers = (json: string): readonly TierOffer[] => {
  const parsed = JSON.parse(json) as {tiers?: unknown}
  if (!Array.isArray(parsed.tiers)) {
    throw new Error(`payment tiers: expected a tiers array, got ${json.slice(0, 80)}`)
  }
  return parsed.tiers.map((raw) => {
    const row = raw as {tier?: unknown; free?: unknown; price?: unknown}
    if (typeof row.tier !== 'number' || !Number.isInteger(row.tier) || row.tier < 0 || row.tier > 6) {
      throw new Error(`payment tiers: expected a tier 0..6, got ${String(row.tier)}`)
    }
    if (typeof row.free !== 'boolean') {
      throw new Error(`payment tiers: tier ${row.tier} has a non-boolean free flag`)
    }
    if (row.price !== null && (typeof row.price !== 'string' || !/^\d+$/.test(row.price))) {
      throw new Error(`payment tiers: tier ${row.tier} price must be a decimal string or null`)
    }
    return {tier: row.tier, free: row.free, price: row.price === null ? null : BigInt(row.price)}
  })
}

/**
 * NIGHT's token colour: 32 zero bytes.
 *
 * ⚠️ **Not an absence.** A caller that means "probe NIGHT" passes this; a caller that means "probe
 * nothing" passes no currency at all, and the two answers differ.
 */
export const NIGHT_COLOUR = new Uint8Array(32)
