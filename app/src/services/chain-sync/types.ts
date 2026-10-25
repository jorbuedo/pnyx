/**
 * Shared types for chain sync implementations.
 *
 * @module
 */

import type {StoredTransaction} from '@pnyx/wallet'
import {Data} from 'effect'
import {logger} from '../../logger'

export {TX_FETCH_MODE, type TxFetchMode} from '@pnyx/wallet'

/**
 * Sync error with chain context.
 */
export class ChainSyncError extends Data.TaggedError('ChainSyncError')<{
  readonly chainId: string
  readonly message: string
  readonly cause?: unknown
}> {}

// ============================================================================
// Balance delta from transactions
// ============================================================================

const parseBigIntSafe = (value: string | undefined): bigint => {
  if (!value) return 0n
  try {
    return BigInt(value)
  } catch (e: unknown) {
    // ⚠️ `0n` is a real value here — a zero balance, a genesis height — so an unparseable one
    // becomes an assertion rather than an absence.
    logger.warn('Chain-sync value could not be parsed as a bigint; using zero', {
      origin: 'chain-sync/types',
      value,
      error: String(e),
    })
    return 0n
  }
}

/**
 * Compute the net native-balance delta from new transactions.
 *
 * When the balance API lags behind the transaction API, this derives the
 * expected balance change from the new transaction data so the snapshot
 * stays in sync with the transaction history.
 *
 * Conservative: only accounts for clear native-token transfers.
 * Token transfers and swaps contribute 0 or -fee (gas only) to avoid
 * incorrect native balance adjustments. Any inaccuracy self-corrects
 * on the next sync when the balance API catches up.
 */
export const computeNativeBalanceDelta = (
  transactions: readonly StoredTransaction[],
  existingTxCount: number,
): bigint => {
  if (transactions.length <= existingTxCount) return 0n

  // Sort by timestamp descending (newest first)
  const sorted = [...transactions].sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0
    if (!a.timestamp) return 1
    if (!b.timestamp) return -1
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  })

  // The first N entries are the newest transactions
  const newCount = transactions.length - existingTxCount
  const newTxs = sorted.slice(0, newCount)

  let delta = 0n
  for (const tx of newTxs) {
    const amount = parseBigIntSafe(tx.amount)
    const fee = parseBigIntSafe(tx.fee)
    const contractAddr = tx.metadata?.contractAddress
    const isToken = typeof contractAddr === 'string' && contractAddr !== ''

    switch (tx.direction) {
      case 'received':
        // Native receive: balance increases by the received amount.
        // Token receive: no native balance change for the receiver.
        if (!isToken) delta += amount
        break
      case 'sent':
        // Native send: balance decreases by amount + gas.
        // Token send: balance decreases by gas only.
        delta -= isToken ? fee : amount + fee
        break
      case 'self':
        // Self-transfer: only gas is consumed.
        delta -= fee
        break
    }
  }

  return delta
}
