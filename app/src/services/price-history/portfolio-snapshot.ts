/**
 * The portfolio as it stood at a past instant — the list half of "the chart and the list must agree
 * about the past".
 *
 * Scrubbing the value chart moves the *total* to a timestamp; this moves the rows under it. Two
 * things follow from reading the balance timeline instead of current holdings, and both are the
 * point of the exercise:
 *
 * - **An asset held then but not now reappears.** A wallet that swapped all its NIGHT for GENS held
 *   NIGHT before the trade, so a snapshot from before it lists NIGHT.
 * - **An asset acquired later is absent**, rather than present with today's balance.
 *
 * Existence is decided by balance, not by metadata or pricing: a row whose balance at `tsSec` is not
 * positive did not exist in that snapshot and is omitted. An asset we cannot *price* still appears
 * with `fiatValue: null` — the same unpriced tier the live list already renders — because failing to
 * value something is not evidence it was not held.
 *
 * @module
 */

import {isNftAsset, type PortfolioAsset} from '../cardano-assets/portfolio'
import {ADA_KEY, type BalanceTimeline, balanceAt} from './balance-timeline'

/** How a row is labelled and scaled. `decimals: null` means no source stated a scale. */
export type SnapshotMeta = {
  readonly label: string
  readonly subtitle?: string
  readonly decimals: number | null
}

/**
 * Every asset held at `tsSec`, as portfolio rows.
 *
 * `meta` supplies label and scale per asset key (ADA is the empty key); `unitFiatAt` is the price of
 * one whole unit in the active fiat at that instant, or `null` when unknown. Both are injected so
 * this stays pure — the caller owns the metadata cache and the price resolvers.
 *
 * The result is unsorted and unfiltered: callers pass it through the same `filterPortfolioAssets` /
 * comparator the live list uses, so a scrubbed list sorts and filters identically.
 */
export const portfolioAt = (
  timeline: BalanceTimeline,
  tsSec: number,
  meta: (assetKey: string) => SnapshotMeta,
  unitFiatAt: (assetKey: string, tsSec: number) => number | null,
  verifiedIds: ReadonlySet<string>,
): readonly PortfolioAsset[] => {
  const rows: PortfolioAsset[] = []
  for (const key of timeline.keys()) {
    const quantity = balanceAt(timeline, key, tsSec)
    // Not held then. A negative balance means the local history is partial for this asset (see
    // `anchorTimeline`), which is equally not evidence of a holding.
    if (quantity <= 0n) continue
    const {label, subtitle, decimals} = meta(key)
    const unitPrice = unitFiatAt(key, tsSec)
    const row: PortfolioAsset = {
      id: key,
      isAda: key === ADA_KEY,
      // Recomputed below by the same heuristic the live list uses; a placeholder here keeps the
      // shape valid for it.
      isNft: false,
      label,
      ...(subtitle === undefined ? {} : {subtitle}),
      decimals,
      quantity,
      // An unknown scale refuses to price rather than mis-scaling by orders of magnitude — the rule
      // `TokenInfo.decimals` states and the aggregate already follows.
      fiatValue: unitPrice === null || decimals === null ? null : (Number(quantity) / 10 ** decimals) * unitPrice,
    }
    rows.push({...row, isNft: isNftAsset(row, verifiedIds)})
  }
  return rows
}
