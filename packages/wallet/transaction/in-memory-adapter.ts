/**
 * In-memory TransactionAdapter stub for boundary tests.
 *
 * Ships here (not in individual test files) so any test that needs a
 * real-looking adapter can import it without pulling in production chain code.
 *
 * @module
 */

import {Effect} from 'effect'
import {ProviderError} from '../errors.js'
import type {ChainId} from '../types.js'
import type {TransactionAdapter} from './transaction-history.js'
import type {TransactionData, TransactionHistoryResponse} from './unified-transaction.js'

export type {TransactionAdapter}

/**
 * Control handle returned by `makeInMemoryAdapter`.
 *
 * Allows tests to inspect call counts and mutate adapter state between queries
 * without restarting the Layer.
 */
export type InMemoryAdapterControl = {
  /** The `TransactionAdapter` to pass to `TransactionHistoryLive`. */
  readonly adapter: TransactionAdapter
  /** Override the transactions returned on the next call. */
  readonly setTransactions: (txs: readonly TransactionData[]) => void
  /** Toggle failure mode — adapter returns `ProviderError` when `true`. */
  readonly setFailing: (fail: boolean) => void
  /** How many times `getTransactions` has been called so far. */
  readonly callCount: () => number
}

/**
 * In-memory `TransactionAdapter` stub for boundary tests.
 *
 * @example
 * ```ts
 * const {adapter, setTransactions, callCount} = makeInMemoryAdapter('cardano:mainnet', [txA])
 * const layer = TransactionHistoryLive({adapters: [adapter], resolveAddresses: ...})
 * ```
 */
export const makeInMemoryAdapter = (
  chainId: ChainId,
  initialTransactions: readonly TransactionData[] = [],
): InMemoryAdapterControl => {
  let transactions = initialTransactions
  let failing = false
  let calls = 0

  const adapter: TransactionAdapter = {
    chainId,
    getTransactions: (_address, _pagination, _filter): Effect.Effect<TransactionHistoryResponse, ProviderError> => {
      calls++
      if (failing) {
        return Effect.fail(new ProviderError({message: `Chain ${chainId} unavailable`}))
      }
      return Effect.succeed({
        transactions,
        hasMore: false,
        total: transactions.length,
      })
    },
    getTransaction: (hash) => Effect.succeed(transactions.find((tx) => tx.hash === hash) ?? null),
  }

  return {
    adapter,
    setTransactions: (txs) => {
      transactions = txs
    },
    setFailing: (f) => {
      failing = f
    },
    callCount: () => calls,
  }
}
