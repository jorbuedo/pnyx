/**
 * Which unit a Midnight fee is legible in.
 *
 * Fees are DUST, and the indexer reports them in **SPECK** — DUST's atomic unit, 10¹⁵ to one DUST
 * (`RegularTransaction.fee`: "The fee for this transaction in SPECK (atomic unit of DUST)"). Real
 * fees on preprod are tiny: a plain transfer came back as `1` speck. Rendered as DUST at the fee
 * preset's precision that is "0 DUST", which tells the user the transaction was free. It was not.
 *
 * So the unit follows the magnitude: below the smallest DUST figure the display can show, the fee is
 * stated in specks, where it is an exact small integer. Above it, DUST reads better than fifteen
 * digits of speck.
 *
 * Pure and separate from the screen so the boundary is testable — "0" for a nonzero fee is exactly
 * the class of bug that hides behind a formatter.
 *
 * @module
 */

/** SPECK per DUST — 15 decimals, matching `DUST_DECIMALS`. */
const SPECK_PER_DUST = 10n ** 15n

/**
 * Fraction digits the DUST display keeps. Below `10^(15-6)` specks a DUST figure rounds to zero at
 * this precision, which is the threshold this module exists to catch.
 */
const DUST_FRACTION_DIGITS = 6n

/** The smallest fee expressible as a nonzero DUST figure: 0.000001 DUST. */
export const MIN_DISPLAYABLE_DUST_SPECKS = 10n ** (15n - DUST_FRACTION_DIGITS)

export type MidnightFeeDisplay = {
  /** Atomic amount to format, in `unit`. */
  readonly amount: bigint
  /** Ticker to label it with. */
  readonly unit: 'DUST' | 'SPECK'
  /** Decimals `amount` carries — zero for SPECK, which is already atomic. */
  readonly decimals: number
}

/**
 * Pick the unit for a fee reported in specks.
 *
 * A zero fee stays DUST: "0 DUST" is true there, and switching units for it would read as a
 * different kind of nothing.
 */
export const midnightFeeDisplay = (specks: bigint): MidnightFeeDisplay =>
  specks !== 0n && specks < MIN_DISPLAYABLE_DUST_SPECKS
    ? {amount: specks, unit: 'SPECK', decimals: 0}
    : {amount: specks, unit: 'DUST', decimals: 15}

/** Exposed for tests and callers that need the scale rather than the display choice. */
export const speckPerDust = (): bigint => SPECK_PER_DUST
