/**
 * Optimistic transaction handling.
 *
 * Manages the state of transactions that have been submitted but not yet confirmed.
 * Provides automatic timeout and rollback mechanisms.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import type {WalletTransaction} from '../types.js'

/**
 * Optimistic transaction state.
 */
export type OptimisticTransaction = {
  readonly tx: WalletTransaction
  readonly submittedAt: Date
  readonly timeoutMs: number
  readonly status: 'pending' | 'confirmed' | 'expired' | 'failed'
}

/**
 * Optimistic state for tracking pending transactions.
 */
export type OptimisticState = {
  readonly transactions: Ref.Ref<ReadonlyMap<string, OptimisticTransaction>>

  /**
   * Add a transaction optimistically.
   */
  readonly add: (tx: WalletTransaction, options?: {readonly timeoutMs?: number}) => Effect.Effect<void, never>

  /**
   * Confirm a transaction has been included in a block.
   */
  readonly confirm: (hash: string) => Effect.Effect<boolean, never>

  /**
   * Mark a transaction as failed.
   */
  readonly fail: (hash: string) => Effect.Effect<boolean, never>

  /**
   * Remove a transaction from optimistic tracking.
   */
  readonly remove: (hash: string) => Effect.Effect<boolean, never>

  /**
   * Get all pending optimistic transactions.
   */
  readonly getPending: () => Effect.Effect<readonly OptimisticTransaction[], never>

  /**
   * Check and expire timed-out transactions.
   */
  readonly checkExpired: () => Effect.Effect<readonly string[], never>

  /**
   * Clear all optimistic transactions.
   */
  readonly clear: () => Effect.Effect<void, never>
}

/**
 * Default timeout for optimistic transactions (10 minutes).
 */
export const DEFAULT_OPTIMISTIC_TIMEOUT = 10 * 60 * 1000

/**
 * Create optimistic state manager.
 */
export const createOptimisticState = (): Effect.Effect<OptimisticState, never, never> =>
  Effect.gen(function* () {
    const transactions = yield* Ref.make<ReadonlyMap<string, OptimisticTransaction>>(new Map())

    const add = (tx: WalletTransaction, options: {readonly timeoutMs?: number} = {}): Effect.Effect<void, never> =>
      Ref.update(transactions, (map) => {
        const newMap = new Map(map)
        newMap.set(tx.hash, {
          tx,
          submittedAt: new Date(),
          timeoutMs: options.timeoutMs ?? DEFAULT_OPTIMISTIC_TIMEOUT,
          status: 'pending',
        })
        return newMap
      })

    const confirm = (hash: string): Effect.Effect<boolean, never> =>
      Ref.modify(transactions, (m) => {
        const optimistic = m.get(hash)
        if (!optimistic) return [false, m] as const
        const newMap = new Map(m)
        newMap.set(hash, {...optimistic, status: 'confirmed'})
        return [true, newMap] as const
      })

    const fail = (hash: string): Effect.Effect<boolean, never> =>
      Ref.modify(transactions, (m) => {
        const optimistic = m.get(hash)
        if (!optimistic) return [false, m] as const
        const newMap = new Map(m)
        newMap.set(hash, {...optimistic, status: 'failed'})
        return [true, newMap] as const
      })

    const remove = (hash: string): Effect.Effect<boolean, never> =>
      Ref.modify(transactions, (m) => {
        if (!m.has(hash)) return [false, m] as const
        const newMap = new Map(m)
        newMap.delete(hash)
        return [true, newMap] as const
      })

    const getPending = (): Effect.Effect<readonly OptimisticTransaction[], never> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(transactions)
        return Array.from(map.values()).filter((t) => t.status === 'pending')
      })

    const checkExpired = (): Effect.Effect<readonly string[], never> =>
      Effect.gen(function* () {
        const now = Date.now()
        const map = yield* Ref.get(transactions)
        const expired: string[] = []

        for (const [hash, optimistic] of map) {
          if (optimistic.status !== 'pending') continue

          const elapsed = now - optimistic.submittedAt.getTime()
          if (elapsed >= optimistic.timeoutMs) {
            expired.push(hash)
          }
        }

        // Update expired transactions
        if (expired.length > 0) {
          yield* Ref.update(transactions, (m) => {
            const newMap = new Map(m)
            for (const hash of expired) {
              const opt = newMap.get(hash)
              if (opt) {
                newMap.set(hash, {...opt, status: 'expired'})
              }
            }
            return newMap
          })
        }

        return expired
      })

    const clear = (): Effect.Effect<void, never> => Ref.set(transactions, new Map())

    return {
      transactions,
      add,
      confirm,
      fail,
      remove,
      getPending,
      checkExpired,
      clear,
    }
  })

/**
 * Add a pending transaction optimistically.
 */
export const addOptimisticTransaction = (
  state: OptimisticState,
  tx: WalletTransaction,
  options?: {readonly timeoutMs?: number},
): Effect.Effect<void, never> => state.add(tx, options)

/**
 * Confirm an optimistic transaction.
 */
export const confirmOptimisticTransaction = (state: OptimisticState, hash: string): Effect.Effect<boolean, never> =>
  state.confirm(hash)

/**
 * Remove an optimistic transaction.
 */
export const removeOptimisticTransaction = (state: OptimisticState, hash: string): Effect.Effect<boolean, never> =>
  state.remove(hash)
