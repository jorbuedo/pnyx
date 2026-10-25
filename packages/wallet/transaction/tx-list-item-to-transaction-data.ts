/**
 * TxListItem → TransactionData projection for the activity list.
 *
 * The list path renders rows out of {@link TxListItem} — the indexed,
 * detail-blob-free shape returned by `TxTable.list`. The UI layer was
 * built against {@link TransactionData}; this mapper preserves that
 * surface so existing components keep reading `tx.assetSymbol`,
 * `tx.iconUrl`, `tx.primaryAssetDelta`, etc.
 *
 * Detail-only fields (`reviewed`, `inputs`, `outputs`, `tokens`,
 * `otherParties`, EVM gas details, …) are intentionally left
 * `undefined`. Components that need them must read via the detail
 * screen path (`loadTransaction` → `mapStoredTransactionToTransactionData`).
 *
 * @module
 */

import {getLogger} from '@pnyx/logger'
import type {TxListItem} from '@pnyx/store/tx-table'
import type {ChainId} from '../types.js'
import {LIST_META_ASSET_IDS_KEY, readAssetIds} from './asset-ids-projection.js'
import {type TransactionData, type TransactionType, TransactionTypes} from './unified-transaction.js'

const logger = getLogger('wallet')

const ALL_TX_TYPES = new Set<string>(Object.values(TransactionTypes) as string[])

const isTransactionType = (s: string): s is TransactionType => ALL_TX_TYPES.has(s)

/**
 * Reverse the `LIST_METADATA_KEYS` projection from
 * {@link storedToTxRow}. Returns an empty object when the list-meta
 * blob is absent or malformed — UI code uses `transaction.metadata?.foo`
 * everywhere it reads these keys, so an empty object is a safe degrade.
 */
const parseListMetadata = (raw: string | null): Record<string, unknown> | undefined => {
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch (e: unknown) {
    logger.warn('Transaction list metadata could not be parsed; the row renders without it', {
      origin: 'tx-list-item-to-transaction-data',
      error: String(e),
    })
    return undefined
  }
}

/**
 * Recover a signed primary delta as a `bigint` for `TransactionData.value`.
 *
 * The list-render code paths read `transaction.value` as the unsigned
 * primary-asset amount and apply sign at display time via
 * `computeSign(transaction)` (which inspects `direction` /
 * `primaryAssetDelta`). We mirror the same convention: `value` is the
 * absolute amount, `primaryAssetDelta` carries the sign for components
 * that look at it directly.
 */
const toAbsBigint = (s: string | null | undefined): bigint => {
  if (s == null || s === '') return 0n
  try {
    const b = BigInt(s)
    return b < 0n ? -b : b
  } catch (e: unknown) {
    // ⚠️ `0n` is a real amount, so an unparseable one renders as a transaction that moved
    // nothing. There is no better fallback at this layer, which is exactly why it must be said.
    logger.warn('Transaction amount could not be parsed; it renders as zero', {
      origin: 'tx-list-item-to-transaction-data',
      value: s,
      error: String(e),
    })
    return 0n
  }
}

const toBigintOrUndefined = (s: string | null | undefined): bigint | undefined => {
  if (s == null || s === '') return undefined
  try {
    return BigInt(s)
  } catch (e: unknown) {
    logger.warn('Transaction value could not be parsed; reporting it absent', {
      origin: 'tx-list-item-to-transaction-data',
      value: s,
      error: String(e),
    })
    return undefined
  }
}

/**
 * Project a {@link TxListItem} into the {@link TransactionData} shape
 * expected by activity-row components.
 *
 * Direction-aware fields (`from` / `to`) are derived from
 * `counterpartyAddress` + `direction`. The detail screen still
 * reconstitutes the rich shape via `mapStoredTransactionToTransactionData`
 * — this mapper exists solely for the list-rendering hot path.
 */
export const txListItemToTransactionData = (item: TxListItem): TransactionData => {
  const rawMetadata = parseListMetadata(item.listMetaJson)
  const assetIds = readAssetIds(rawMetadata)
  // Strip the internal projection key so the user-visible `metadata` object
  // never leaks the storage detail. Returns `undefined` (not `{}`) when the
  // remaining bag is empty, preserving the pre-projection shape for callers
  // that check `if (tx.metadata)`.
  let metadata: Record<string, unknown> | undefined
  if (rawMetadata) {
    const visible: Record<string, unknown> = {}
    let hasAny = false
    for (const [key, value] of Object.entries(rawMetadata)) {
      if (key === LIST_META_ASSET_IDS_KEY) continue
      visible[key] = value
      hasAny = true
    }
    metadata = hasAny ? visible : undefined
  }
  const type: TransactionType = isTransactionType(item.type) ? item.type : 'unknown'
  return {
    hash: item.hash,
    chain: item.chainId as ChainId,
    status: item.status,
    direction: item.direction,
    type,
    timestamp: item.timestamp ?? undefined,
    submittedAt: item.submittedAt ?? undefined,
    from: item.direction === 'received' ? (item.counterpartyAddress ?? '') : '',
    to: item.direction === 'sent' ? (item.counterpartyAddress ?? undefined) : undefined,
    value: toAbsBigint(item.amount),
    fee: toBigintOrUndefined(item.fee),
    iconUrl: item.iconUrl ?? undefined,
    assetSymbol: item.assetSymbol ?? undefined,
    assetDecimals: item.assetDecimals ?? undefined,
    tokenId: item.tokenId ?? undefined,
    contractAddress: item.contractAddress ?? undefined,
    primaryAssetDelta: item.primaryAssetDelta ?? undefined,
    additionalAssetCount: item.additionalAssetCount,
    ...(item.hasNft ? {hasNft: true as const} : {}),
    assetIds,
    metadata,
  }
}

export const txListItemsToTransactionData = (items: ReadonlyArray<TxListItem>): TransactionData[] =>
  items.map(txListItemToTransactionData)
