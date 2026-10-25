/**
 * Shared `assetIds` projection for the list-render path.
 *
 * `assetDeltas` (Cardano) and `tokenTransfers` (EVM/Solana) live inside
 * the detail blob and are dropped by the list projection. The per-asset
 * filter at `filter-pipeline.ts` needs to know "did this tx touch asset
 * X?" without parsing the blob, so we collapse those two collections —
 * plus `contractAddress` / `tokenId` for chains that only carry a single
 * primary token — into a flat `string[]` projected into `TxRow.listMetaJson`.
 *
 * Storage layer is JSON-blob; no SQL schema change needed.
 *
 * @module
 */

import type {TransactionData} from './unified-transaction.js'

/**
 * Internal key under which the projected asset id list is stored inside
 * `TxRow.listMetaJson`. Prefixed `__` so consumers reading
 * `tx.metadata.<x>` see it as a non-public field and the list-item
 * mapper can strip it from the user-visible metadata.
 */
export const LIST_META_ASSET_IDS_KEY = '__assetIds'

/**
 * Collect the union of every asset id mentioned by the tx — Cardano
 * `assetDeltas`, EVM/Solana `tokenTransfers` (by `assetId` and by
 * `contractAddress`, since some callers key off either), plus the
 * top-level `tokenId` / `contractAddress` for single-asset txs.
 */
export const projectAssetIds = (data: TransactionData): readonly string[] => {
  const ids = new Set<string>()
  data.assetDeltas?.forEach((d) => {
    if (d.assetId) ids.add(d.assetId)
  })
  data.tokenTransfers?.forEach((t) => {
    if (t.assetId) ids.add(t.assetId)
    if (t.contractAddress) ids.add(t.contractAddress)
  })
  if (data.tokenId) ids.add(data.tokenId)
  if (data.contractAddress) ids.add(data.contractAddress)
  return [...ids]
}

/**
 * Recover `assetIds` from a parsed `listMetaJson` blob.
 *
 * Returns `undefined` if the key is missing or malformed — old rows
 * predating this projection have no entry, so the filter falls through
 * to the legacy `tokenTransfers` / `assetDeltas` check. Next sync
 * re-writes the row with the projection populated.
 */
export const readAssetIds = (metadata: Record<string, unknown> | undefined): readonly string[] | undefined => {
  if (!metadata) return undefined
  const raw = metadata[LIST_META_ASSET_IDS_KEY]
  if (!Array.isArray(raw)) return undefined
  const ids = raw.filter((v): v is string => typeof v === 'string')
  return ids.length > 0 ? ids : undefined
}
