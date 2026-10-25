/**
 * Interpreting the Midnight indexer's `dustGenerationStatus` — the only source for whether
 * DUST is actually *generating*.
 *
 * The Cardano-side scan proves a registration exists; it cannot prove DUST flows, and it
 * cannot say how much of the NIGHT a wallet holds is eligible. Those are Midnight-side facts.
 *
 * **The indexer is authoritative on generation and must never be believed about registration.**
 * A multiply-registered wallet comes back `registered: false` with zeroes — verified live on
 * 2026-07-28 against a real mainnet wallet holding 1.51M NIGHT under two registrations. That
 * is the documented Proposal-0018 trap, and acting on it would prompt the user to register a
 * *third* time, making the problem worse. So `registered: false` yields no observation at all
 * and the Cardano scan's verdict stands.
 *
 * Units, from `spec/dust.md` and confirmed against live rows: **1 DUST = 10¹⁵ Specks**,
 * **1 NIGHT = 10⁶ Stars**; capacity is `5 DUST` per NIGHT and the rate is
 * `8,267 Specks/Star/sec`. Both reproduce exactly — 36,505,016 Stars × 8,267 =
 * 301,786,967,272, the rate the indexer reported for that wallet.
 *
 * Pure: the fetch lives in `indexer.ts` so this golden-tests in isolation.
 *
 * @module
 */

import type {ObservedDust} from './registration-health'

/** Atomic DUST unit. 1 DUST = 10¹⁵ Specks. */
export const DUST_DECIMALS = 15
/** Atomic NIGHT unit. 1 NIGHT = 10⁶ Stars. */
export const NIGHT_DECIMALS = 6

/**
 * One `dustGenerationStatus` row, with every numeric field as the indexer sends it — a
 * decimal string, or absent. Kept as strings so parsing (and the absent case) is this
 * module's decision rather than the transport's.
 */
export type DustGenerationRow = {
  readonly registered: boolean
  readonly dustAddress?: string
  /** Eligible (post-registration) NIGHT, in Stars. */
  readonly nightBalance?: string
  /** Specks per second. */
  readonly generationRate?: string
  /** Specks. */
  readonly currentCapacity?: string
  /** Specks. */
  readonly maxCapacity?: string
}

/** What the indexer said, or why it said nothing. */
export type DustGenerationSnapshot =
  | {readonly kind: 'ok'; readonly row: DustGenerationRow}
  /** Reachable but has no live registration for this address — no observation to make. */
  | {readonly kind: 'none'}
  /** Unreachable, malformed, or not configured. Distinct from `none`: absence of evidence. */
  | {readonly kind: 'unavailable'}

/**
 * Parsed generation telemetry. Every field is `null` when the indexer omitted it — absent is
 * never rendered as zero, because "we were not told" and "it is zero" lead to opposite
 * conclusions about whether anything is wrong.
 */
export type DustGeneration = {
  readonly dustAddress: string | null
  /** Eligible NIGHT in Stars — the post-registration subset, not everything held. */
  readonly eligibleNightStars: bigint | null
  readonly generationRateSpecks: bigint | null
  readonly currentCapacitySpecks: bigint | null
  readonly maxCapacitySpecks: bigint | null
}

/**
 * A non-negative integer decimal string as a bigint; `null` for absent, empty, or anything
 * that is not one. Deliberately strict: a value we cannot read is not a value we may guess.
 */
const toStars = (value: string | undefined): bigint | null => {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  return BigInt(trimmed)
}

export const parseDustGeneration = (row: DustGenerationRow): DustGeneration => ({
  dustAddress: row.dustAddress ?? null,
  eligibleNightStars: toStars(row.nightBalance),
  generationRateSpecks: toStars(row.generationRate),
  currentCapacitySpecks: toStars(row.currentCapacity),
  maxCapacitySpecks: toStars(row.maxCapacity),
})

/**
 * The snapshot as the health assessment consumes it, or `null` when there is nothing to
 * observe — which makes the assessment fall back to what Cardano alone can prove.
 *
 * `cursorSlot` is `null` because the v4 schema exposes no Cardano-side sync cursor. The
 * earlier implementation passed `0`, which happens to read as "inside the lag window" and so
 * gave the right answer for the wrong reason; saying `null` keeps the heuristic from running
 * on a number nobody measured.
 */
export const toObservedDust = (snapshot: DustGenerationSnapshot): ObservedDust | null => {
  if (snapshot.kind !== 'ok') return null
  // See the module note: a multiply-registered wallet reports `registered: false`, so this is
  // not a statement that the wallet is unregistered — only that there is no single
  // registration to observe. The Cardano scan already knows which of the two it is.
  if (!snapshot.row.registered) return null
  const gen = parseDustGeneration(snapshot.row)
  const rate = gen.generationRateSpecks
  return {
    accruing: rate !== null && rate > 0n,
    cursorSlot: null,
    ...(gen.eligibleNightStars === null ? {} : {eligibleNight: gen.eligibleNightStars}),
  }
}
