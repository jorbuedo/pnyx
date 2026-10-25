/**
 * Pure transaction filter pipeline.
 *
 * Extracted from `transaction-history.ts` so it can be tested in isolation
 * and reused by callers that already hold a flat transaction array.
 *
 * @module
 */

import type {TransactionDirection} from '../types.js'
import type {TransactionData, TransactionFilter, TransactionType} from './unified-transaction.js'

const TYPE_LABELS: Record<TransactionType, string> = {
  sent: 'Sent',
  received: 'Received',
  self: 'Self transfer',
  multi: 'Multi',
  transfer: 'Cross-network transfer',
  claim: 'Claimed',
  approval: 'Approval',
  approvalRevoke: 'Revoke approval',
  stakeRegistration: 'Stake registered',
  stakeDeregistration: 'Stake deregistered',
  stakeDelegation: 'Staked',
  stakeUndelegation: 'Unstaked',
  poolRegistration: 'Pool registered',
  poolRetirement: 'Pool retired',
  withdrawal: 'Rewards withdrawn',
  swap: 'Swapped',
  swapCreated: 'Swap created',
  swapResolved: 'Swap resolved',
  swapCancel: 'Swap cancelled',
  smartContract: 'Smart contract',
  collateralCreation: 'Collateral creation',
  mint: 'Minted',
  burn: 'Burnt',
  nightRedemption: 'Night redeemed',
  voteDelegation: 'Vote delegated',
  drepRegistration: 'DRep registered',
  drepDeregistration: 'DRep deregistered',
  drepUpdate: 'DRep updated',
  stakeAndVoteDelegation: 'Staked and delegated vote',
  stakeRegistrationAndDelegation: 'Staked',
  stakeVoteRegistrationAndDelegation: 'Staked and delegated vote',
  voteRegistrationAndDelegation: 'Vote delegated',
  committeeHotAuth: 'Committee hot key',
  committeeColdResign: 'Committee cold resign',
  genesisKeyDelegation: 'Genesis key delegation',
  moveInstantaneousRewards: 'Treasury reward',
  cardWithdrawal: 'Sent',
  nft: 'NFT',
  unknown: 'Unknown',
}

export const getTypeLabel = (type: TransactionType, direction: TransactionDirection): string =>
  TYPE_LABELS[type] ?? (direction === 'sent' ? 'Sent' : direction === 'received' ? 'Received' : 'Self')

const matchesSearch = (tx: TransactionData, q: string): boolean => {
  if (tx.hash.toLowerCase().includes(q)) return true
  if (tx.from.toLowerCase().includes(q)) return true
  if (tx.to?.toLowerCase().includes(q)) return true
  if (tx.contractAddress?.toLowerCase().includes(q)) return true
  if (getTypeLabel(tx.type, tx.direction).toLowerCase().includes(q)) return true
  if (tx.assetSymbol?.toLowerCase().includes(q)) return true
  if (tx.assetName?.toLowerCase().includes(q)) return true
  if (tx.tokens?.some((t) => t.symbol?.toLowerCase().includes(q))) return true
  if (
    tx.tokenTransfers?.some(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.from.toLowerCase().includes(q) ||
        t.to.toLowerCase().includes(q) ||
        (t.contractAddress?.toLowerCase().includes(q) ?? false),
    )
  )
    return true
  if (tx.nftTransfers?.some((t) => t.name?.toLowerCase().includes(q))) return true
  if (tx.swapFromAsset?.symbol.toLowerCase().includes(q)) return true
  if (tx.swapToAsset?.symbol.toLowerCase().includes(q)) return true
  if (tx.methodName?.toLowerCase().includes(q)) return true
  return false
}

type TxPredicate = (tx: TransactionData) => boolean

const tokenMatches = (tx: TransactionData, tokenLower: string): boolean => {
  // Native chain assets (ADA, ETH, BTC, …) surface only as `assetSymbol`;
  // their `tokens` array is empty because there is no separate transfer.
  if (tx.assetSymbol?.toLowerCase().includes(tokenLower)) return true
  if (
    tx.tokens?.some(
      (t) => t.id.toLowerCase().includes(tokenLower) || (t.symbol?.toLowerCase().includes(tokenLower) ?? false),
    )
  )
    return true
  if (tx.tokenTransfers?.some((t) => t.symbol?.toLowerCase().includes(tokenLower))) return true
  return false
}

const assetIdMatches = (tx: TransactionData, assetId: string): boolean =>
  // `assetIds` is the canonical list-render projection (populated by both
  // `txListItemToTransactionData` and `mapStoredTransactionToTransactionData`).
  // `tokenTransfers` / `assetDeltas` are the detail-only shapes — kept here
  // so tests and any caller that builds a `TransactionData` literal directly
  // (without going through the mappers) still filter correctly.
  (tx.assetIds?.includes(assetId) ?? false) ||
  (tx.tokenTransfers?.some((t) => t.assetId === assetId) ?? false) ||
  (tx.assetDeltas?.some((d) => d.assetId === assetId) ?? false)

/**
 * Build a single composed predicate from a `TransactionFilter`.
 *
 * Returns `null` when the filter has no active criteria — callers can then
 * skip the `.filter()` call entirely and return the input reference. All
 * enabled checks run inline inside one closure per transaction; filter-wide
 * work (lowercasing the search query, normalizing the `type` array,
 * converting dates to seconds) is done once at build time, not per row.
 *
 * Exposed so callers can compose additional checks (e.g. dust filter) into
 * the same `.filter()` pass instead of chaining separate passes.
 */
export const buildFilterPredicate = (filter?: TransactionFilter): TxPredicate | null => {
  if (!filter) return null

  const direction = filter.direction
  const types = filter.type === undefined ? undefined : Array.isArray(filter.type) ? filter.type : [filter.type]
  const status = filter.status
  const chain = filter.chain
  const startSec = filter.startDate === undefined ? undefined : Math.floor(filter.startDate.getTime() / 1000)
  const endSec = filter.endDate === undefined ? undefined : Math.floor(filter.endDate.getTime() / 1000)
  const minAmount = filter.minAmount
  const maxAmount = filter.maxAmount
  const search = filter.search === undefined ? undefined : filter.search.toLowerCase()
  const tokenLower = filter.token === undefined ? undefined : filter.token.toLowerCase()
  const assetId = filter.assetId

  const hasAny =
    direction !== undefined ||
    types !== undefined ||
    status !== undefined ||
    chain !== undefined ||
    startSec !== undefined ||
    endSec !== undefined ||
    minAmount !== undefined ||
    maxAmount !== undefined ||
    search !== undefined ||
    tokenLower !== undefined ||
    assetId !== undefined

  if (!hasAny) return null

  return (tx) => {
    if (direction !== undefined && tx.direction !== direction) return false
    if (types !== undefined && !types.includes(tx.type)) return false
    if (status !== undefined && tx.status !== status) return false
    if (chain !== undefined && tx.chain !== chain) return false
    if (startSec !== undefined && (tx.timestamp ?? 0) < startSec) return false
    if (endSec !== undefined && (tx.timestamp ?? Number.MAX_SAFE_INTEGER) > endSec) return false
    if (minAmount !== undefined && tx.value < minAmount) return false
    if (maxAmount !== undefined && tx.value > maxAmount) return false
    if (search !== undefined && !matchesSearch(tx, search)) return false
    if (tokenLower !== undefined && !tokenMatches(tx, tokenLower)) return false
    if (assetId !== undefined && !assetIdMatches(tx, assetId)) return false
    return true
  }
}

/**
 * Apply a `TransactionFilter` to a list of transactions.
 *
 * Pure function — no side effects. Single `.filter()` pass over the input
 * regardless of how many filter criteria are active.
 */
export const applyFilter = (
  transactions: readonly TransactionData[],
  filter?: TransactionFilter,
): readonly TransactionData[] => {
  const predicate = buildFilterPredicate(filter)
  return predicate ? transactions.filter(predicate) : transactions
}
