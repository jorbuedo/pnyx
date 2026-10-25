/**
 * Sync orchestration.
 *
 * @module
 */

import {Effect, Layer, Ref} from 'effect'
import {SyncError} from '../errors.js'
import type {SyncConfig, SyncState, WalletGroupId, WalletSyncState, WalletTransaction} from '../types.js'
import {SyncManager} from '../types.js'
import {type BackoffState, calculateBackoff, createBackoffState, resetBackoff} from './backoff.js'
import {parallelSync, prioritizeWallets} from './sync-strategies.js'

/**
 * Wallet syncer function type.
 */
export type WalletSyncer = (id: WalletGroupId) => Effect.Effect<void, SyncError>

/**
 * Default sync configuration.
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  concurrency: 2,
  staggerMs: 500,
  backoff: {
    initial: 1000,
    max: 60000,
    multiplier: 2,
  },
  prioritization: 'lastSelected',
}

/**
 * Configuration for SyncManager.
 */
export type SyncManagerConfig = {
  readonly syncWallet?: WalletSyncer
  readonly config?: Partial<SyncConfig>
  readonly wallets?: () => Effect.Effect<ReadonlyMap<WalletGroupId, import('../types.js').WalletGroup>, never>
  readonly selectedWalletGroupId?: () => Effect.Effect<WalletGroupId | null, never>
}

/**
 * Create a SyncManager implementation.
 */
export const createSyncManager = (config: SyncManagerConfig = {}): Effect.Effect<SyncManager, never, never> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<SyncState>('idle')
    const walletStates = yield* Ref.make<ReadonlyMap<WalletGroupId, WalletSyncState>>(new Map())
    const backoffStates = yield* Ref.make<ReadonlyMap<WalletGroupId, BackoffState>>(new Map())

    const fullConfig: SyncConfig = {
      ...DEFAULT_SYNC_CONFIG,
      ...config.config,
      backoff: {
        ...DEFAULT_SYNC_CONFIG.backoff,
        ...config.config?.backoff,
      },
    }

    const updateWalletState = (
      id: WalletGroupId,
      update: Partial<WalletSyncState>,
    ): Effect.Effect<void, never, never> =>
      Ref.update(walletStates, (map) => {
        const current = map.get(id) ?? {
          groupId: id,
          state: 'idle' as const,
        }
        return new Map([...map, [id, {...current, ...update}]])
      })

    const start = (): Effect.Effect<void, never> => Ref.set(state, 'idle')

    const stop = (): Effect.Effect<void, never> => Ref.set(state, 'idle')

    const pause = (): Effect.Effect<void, never> => Ref.set(state, 'paused')

    const resume = (): Effect.Effect<void, never> => Ref.set(state, 'idle')

    const syncWallet = (id: WalletGroupId): Effect.Effect<void, SyncError> =>
      Effect.gen(function* () {
        if (!config.syncWallet) {
          return yield* Effect.fail(
            new SyncError({
              message: 'No wallet syncer configured',
            }),
          )
        }

        // Check if paused
        const currentState = yield* Ref.get(state)
        if (currentState === 'paused') {
          return
        }

        // Update wallet state to syncing
        yield* updateWalletState(id, {state: 'syncing', progress: 0})

        // Try to sync with backoff
        const backoffMap = yield* Ref.get(backoffStates)
        let backoff = backoffMap.get(id) ?? createBackoffState()

        const result = yield* Effect.either(config.syncWallet(id))

        if (result._tag === 'Left') {
          // Sync failed
          const {delay, nextState} = calculateBackoff(backoff, fullConfig.backoff)
          backoff = nextState

          yield* Ref.update(backoffStates, (map) => new Map([...map, [id, backoff]]))
          yield* updateWalletState(id, {
            state: 'error',
            lastError: result.left.message,
          })

          // Wait before potentially retrying
          yield* Effect.sleep(delay)

          return yield* Effect.fail(result.left)
        }

        // Sync succeeded
        backoff = resetBackoff(backoff)
        yield* Ref.update(backoffStates, (map) => new Map([...map, [id, backoff]]))
        yield* updateWalletState(id, {
          state: 'idle',
          lastSynced: new Date(),
        })
      })

    const syncAll = (): Effect.Effect<ReadonlyMap<WalletGroupId, SyncError | null>, never> =>
      Effect.gen(function* () {
        // Get wallet list
        const wallets = config.wallets ? yield* config.wallets() : new Map()
        const selectedId = config.selectedWalletGroupId ? yield* config.selectedWalletGroupId() : null
        const states = yield* Ref.get(walletStates)

        // Prioritize wallets
        const prioritized = prioritizeWallets(wallets, states, selectedId, fullConfig.prioritization)

        // Set global state to syncing
        yield* Ref.set(state, 'syncing')

        // Sync in parallel with concurrency limit
        const results = yield* parallelSync(prioritized, syncWallet, fullConfig.concurrency, fullConfig.staggerMs)

        // Set global state back to idle
        yield* Ref.set(state, 'idle')

        return results
      })

    const onTransactionSubmitted = (tx: WalletTransaction): Effect.Effect<void, never> =>
      Effect.sync(() => {
        // When a transaction is submitted, we should trigger a sync
        // to get the updated state. This is handled by the caller.
        // Here we just log for now.
        void tx // Acknowledge the transaction
      })

    return {
      state,
      walletStates,
      start,
      stop,
      pause,
      resume,
      syncWallet,
      syncAll,
      onTransactionSubmitted,
    }
  })

/**
 * SyncManager Layer.
 */
export const SyncManagerLayer = (config?: SyncManagerConfig) => Layer.effect(SyncManager, createSyncManager(config))
