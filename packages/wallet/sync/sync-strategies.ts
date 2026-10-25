/**
 * Sync prioritization and parallel sync strategies.
 *
 * @module
 */

import {Effect} from 'effect'
import type {SyncConfig, WalletGroup, WalletGroupId, WalletSyncState} from '../types.js'

/**
 * Sync strategy type.
 */
export type SyncStrategy = {
  readonly name: string
  readonly prioritize: (
    wallets: ReadonlyMap<WalletGroupId, WalletGroup>,
    states: ReadonlyMap<WalletGroupId, WalletSyncState>,
    selectedWalletGroupId: WalletGroupId | null,
  ) => readonly WalletGroupId[]
}

/**
 * Prioritize wallets for sync based on configuration.
 *
 * Strategies:
 * - 'lastSelected': Selected wallet first, then by last sync time
 * - 'oldest': Oldest synced first (need most update)
 * - 'none': No specific order
 */
export const prioritizeWallets = (
  wallets: ReadonlyMap<WalletGroupId, WalletGroup>,
  states: ReadonlyMap<WalletGroupId, WalletSyncState>,
  selectedWalletGroupId: WalletGroupId | null,
  strategy: SyncConfig['prioritization'],
): readonly WalletGroupId[] => {
  const walletIds = Array.from(wallets.keys())

  switch (strategy) {
    case 'lastSelected':
      return walletIds.sort((a, b) => {
        // Selected wallet first
        if (a === selectedWalletGroupId) return -1
        if (b === selectedWalletGroupId) return 1

        // Then by last sync time (oldest first)
        const stateA = states.get(a)
        const stateB = states.get(b)
        const timeA = stateA?.lastSynced?.getTime() ?? 0
        const timeB = stateB?.lastSynced?.getTime() ?? 0
        return timeA - timeB
      })

    case 'oldest':
      return walletIds.sort((a, b) => {
        const stateA = states.get(a)
        const stateB = states.get(b)
        const timeA = stateA?.lastSynced?.getTime() ?? 0
        const timeB = stateB?.lastSynced?.getTime() ?? 0
        return timeA - timeB
      })

    default:
      return walletIds
  }
}

/**
 * Create a sync strategy.
 */
export const createSyncStrategy = (name: string, prioritize: SyncStrategy['prioritize']): SyncStrategy => ({
  name,
  prioritize,
})

/**
 * Last-selected-first strategy.
 */
export const lastSelectedStrategy: SyncStrategy = createSyncStrategy(
  'lastSelected',
  (wallets, states, selectedWalletGroupId) => prioritizeWallets(wallets, states, selectedWalletGroupId, 'lastSelected'),
)

/**
 * Oldest-first strategy.
 */
export const oldestFirstStrategy: SyncStrategy = createSyncStrategy(
  'oldest',
  (wallets, states, selectedWalletGroupId) => prioritizeWallets(wallets, states, selectedWalletGroupId, 'oldest'),
)

/**
 * No prioritization strategy.
 */
export const noPrioritizationStrategy: SyncStrategy = createSyncStrategy(
  'none',
  (wallets, states, selectedWalletGroupId) => prioritizeWallets(wallets, states, selectedWalletGroupId, 'none'),
)

/**
 * Parallel sync with concurrency limit.
 *
 * @param walletIds - Ordered wallet IDs to sync
 * @param syncFn - Function to sync a single wallet
 * @param concurrency - Maximum concurrent syncs
 * @param staggerMs - Delay between starting syncs
 * @returns Map of wallet ID to result (error or null for success)
 */
export const parallelSync = <E>(
  walletIds: readonly WalletGroupId[],
  syncFn: (id: WalletGroupId) => Effect.Effect<void, E>,
  concurrency: number,
  staggerMs: number,
): Effect.Effect<ReadonlyMap<WalletGroupId, E | null>, never, never> =>
  Effect.gen(function* () {
    const results = new Map<WalletGroupId, E | null>()

    // Process wallets in batches
    for (let i = 0; i < walletIds.length; i += concurrency) {
      const batch = walletIds.slice(i, i + concurrency)

      // Start batch with stagger
      const batchPromises = batch.map((id, index) =>
        Effect.gen(function* () {
          // Stagger start times within batch
          if (index > 0 && staggerMs > 0) {
            yield* Effect.sleep(staggerMs * index)
          }

          const result = yield* Effect.either(syncFn(id))
          if (result._tag === 'Left') {
            results.set(id, result.left)
          } else {
            results.set(id, null)
          }
        }),
      )

      // Wait for batch to complete
      yield* Effect.all(batchPromises, {concurrency: 'unbounded'})
    }

    return results
  })

/**
 * Calculate next sync time based on state.
 */
export const getNextSyncTime = (state: WalletSyncState, intervalMs: number): Date => {
  if (!state.lastSynced) {
    return new Date() // Sync immediately
  }
  return new Date(state.lastSynced.getTime() + intervalMs)
}

/**
 * Check if a wallet needs syncing.
 */
export const needsSync = (state: WalletSyncState, intervalMs: number, now: Date = new Date()): boolean => {
  if (state.state === 'syncing') return false
  if (!state.lastSynced) return true
  return now.getTime() >= state.lastSynced.getTime() + intervalMs
}

/**
 * Filter wallets that need syncing.
 */
export const getWalletsNeedingSync = (
  states: ReadonlyMap<WalletGroupId, WalletSyncState>,
  intervalMs: number,
  now: Date = new Date(),
): readonly WalletGroupId[] => {
  const needing: WalletGroupId[] = []
  for (const [id, state] of states) {
    if (needsSync(state, intervalMs, now)) {
      needing.push(id)
    }
  }
  return needing
}
