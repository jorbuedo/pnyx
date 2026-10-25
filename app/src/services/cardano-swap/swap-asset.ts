/**
 * Asset-id ↔ SteelSwap **swap-engine** unit mapping.
 *
 * The swap engine (`/api/v2/swap/*`) is the one place ADA's unit is the literal
 * string `"lovelace"` — everywhere else in SteelSwap (metadata, prices, icons)
 * ADA is the empty unit `""`. Amounts here are base-unit integers as strings
 * (100 ADA = `"100000000"`; a token uses its own decimals). Getting this wrong
 * yields `no_route`, so swap code must go through these helpers, never
 * `assetIdToUnit`.
 *
 * @module
 */

import {assetIdToUnit, unitToAssetId} from '../cardano-assets/asset-id'

/** ADA's unit in the swap engine. */
export const SWAP_ADA_UNIT = 'lovelace'

/** App asset id (`"policy.name"`, or `''`/`'.'` for ADA) → swap unit. */
export const assetIdToSwapUnit = (assetId: string): string | null => {
  const unit = assetIdToUnit(assetId)
  if (unit === null) return null
  return unit.length === 0 ? SWAP_ADA_UNIT : unit
}

/** Swap unit → app asset id. `"lovelace"` → `''` (ADA). */
export const swapUnitToAssetId = (unit: string): string | null => (unit === SWAP_ADA_UNIT ? '' : unitToAssetId(unit))

/** Base-unit integer amount (bigint) → the string the swap API expects. */
export const toSwapAmount = (baseUnits: bigint): string => baseUnits.toString()
