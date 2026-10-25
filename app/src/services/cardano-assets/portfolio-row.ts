/**
 * Codec between the persisted `AssetRow` (the `@pnyx/store` assets table) and
 * the Cardano portfolio's own detail shape:
 * the sort/filter columns (`usdValue`, `assetNumber`, `assetType`) are projected
 * out, and the full asset rides in `detailJson` so the store stays domain-free.
 *
 * `usdValue` is stored in **USD** so the single `usd_value` index
 * sorts correctly in any display currency — the screen converts USD→fiat via a
 * linear FX factor at render. ADA is stored under the `.` sentinel id.
 *
 * @module
 */

import type {AssetRow} from '@pnyx/store/assets-table'
import {logger} from '../../logger'
import {tokenDisplayNames} from './token-display'
import type {TokenInfo} from './token-metadata'

/** ADA's row id (its app id is `''`; the table PK column is TEXT NOT NULL). */
export const ADA_ROW_ID = '.'

/** The full asset serialized into `AssetRow.detailJson`. */
export type PortfolioDetail = {
  readonly id: string
  readonly label: string
  /** `null` when no source stated the scale — never silently 0. */
  /** The fuller name, when it says more than `label` — see `tokenDisplayNames`. */
  readonly subtitle?: string
  readonly decimals: number | null
  /** bigint base-unit quantity as a decimal string (JSON-safe). */
  readonly quantity: string
  readonly isNft: boolean
  readonly hasIcon: boolean
}

const clampUsd = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

/**
 * Build a storable `AssetRow` for `info` holding `quantity` base units, worth
 * `usdValue` USD total (0 when unpriced / an NFT).
 */
export const toAssetRow = (
  ref: {readonly groupId: string; readonly chainId: string; readonly accountIndex: number},
  info: TokenInfo,
  quantity: bigint,
  usdValue: number,
): AssetRow => {
  // Unknown scale ⇒ no meaningful asset number. 0 keeps it out of value sorting
  // rather than claiming a magnitude we cannot support.
  const assetNumber = info.decimals === null ? 0 : Number(quantity) / 10 ** info.decimals
  const {primary, secondary} = tokenDisplayNames(info)
  const detail: PortfolioDetail = {
    id: info.id,
    label: primary,
    ...(secondary !== undefined ? {subtitle: secondary} : {}),
    decimals: info.decimals,
    quantity: quantity.toString(),
    isNft: info.isNft,
    hasIcon: info.hasIcon,
  }
  return {
    ...ref,
    id: info.id.length > 0 ? info.id : ADA_ROW_ID,
    assetType: info.isNft ? 'NFT' : 'TOKEN',
    usdValue: clampUsd(usdValue),
    assetNumber: Number.isFinite(assetNumber) ? assetNumber : 0,
    detailJson: JSON.stringify(detail),
  }
}

/** Decode a persisted row, or `null` when the blob is unusable (treated as a miss). */
export const fromAssetRow = (row: AssetRow): {readonly detail: PortfolioDetail; readonly usdValue: number} | null => {
  try {
    const d = JSON.parse(row.detailJson) as Partial<PortfolioDetail>
    if (typeof d.id !== 'string' || typeof d.label !== 'string') return null
    if (d.decimals !== null && typeof d.decimals !== 'number') return null
    if (typeof d.quantity !== 'string') return null
    return {
      detail: {
        id: d.id,
        label: d.label,
        ...(typeof d.subtitle === 'string' && d.subtitle.length > 0 ? {subtitle: d.subtitle} : {}),
        decimals: d.decimals ?? null,
        quantity: d.quantity,
        isNft: d.isNft === true,
        hasIcon: d.hasIcon === true,
      },
      usdValue: row.usdValue,
    }
  } catch (e: unknown) {
    // `null` drops the row from the portfolio, so a holding the user owns simply does not
    // appear — the worst possible silent outcome on this surface.
    logger.warn('Portfolio row could not be built; the holding is not shown', {
      origin: 'portfolio-row',
      error: String(e),
    })
    return null
  }
}
