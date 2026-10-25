/**
 * Per-chain adaptive sync scheduler.
 *
 * Each chain wallet (groupId + chainId) gets its own independently-running
 * fiber with an adaptive Effect Schedule:
 *
 * - **Idle**: 60s interval for active group, 180s for background groups
 * - **Post-TX**: aggressive polling (5s intervals for 2min) after tx submission
 * - **Staggered**: fibers are forked with small delays between them
 * - **Prioritized**: active wallet group's chains sync first with shorter intervals
 *
 * Replaces the React-hook-based `usePeriodicSync` with a fully Effect-TS-based
 * solution that can be tuned per-chain without React re-renders.
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import {Deferred, Effect, Fiber, Ref, Schedule, SubscriptionRef} from 'effect'
import type {WalletGroupId} from '../types.js'

// ============================================================================
// Types
// ============================================================================

/** Sync status for a single chain wallet. */
export type ChainSyncStatus = 'idle' | 'syncing' | 'error'

/** State for a single chain wallet's sync fiber. */
export type ChainSyncState = {
  readonly status: ChainSyncStatus
  readonly lastSynced?: number | undefined
  readonly lastChanged?: number | undefined
  readonly lastError?: string | undefined
}

/** Key for identifying a chain wallet in the state map. */
export type ChainWalletKey = `${string}:${string}`

/** Configuration for the chain sync scheduler. */
export type ChainSyncSchedulerConfig = {
  /** Base interval for idle sync (ms). Default: 60_000 */
  readonly baseIntervalMs?: number | undefined
  /** Interval for post-tx aggressive polling (ms). Default: 10_000 */
  readonly postTxIntervalMs?: number | undefined
  /** Duration of post-tx aggressive polling (ms). Default: 120_000 (2 min) */
  readonly postTxDurationMs?: number | undefined
  /** Delay between forking fibers (ms). Default: 200 */
  readonly staggerMs?: number | undefined
  /** Multiplier for non-active group intervals. Default: 3 */
  readonly backgroundMultiplier?: number | undefined
}

/** Function that syncs a single chain wallet. Returns true if data changed. */
export type ChainSyncer = (groupId: WalletGroupId, chainId: ChainId) => Effect.Effect<boolean, Error>

/** Function that checks if a pending tx hash has been confirmed. */
export type TxConfirmationChecker = (
  groupId: WalletGroupId,
  chainId: ChainId,
  txHash: string,
) => Effect.Effect<boolean, never>

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_BASE_INTERVAL_MS = 60_000
const DEFAULT_POST_TX_INTERVAL_MS = 10_000
const DEFAULT_POST_TX_DURATION_MS = 120_000
const DEFAULT_STAGGER_MS = 200
const DEFAULT_BACKGROUND_MULTIPLIER = 3

// ============================================================================
// Helpers
// ============================================================================

const chainKey = (groupId: string, chainId: string): ChainWalletKey => `${groupId}:${chainId}` as ChainWalletKey

// ============================================================================
// Scheduler
// ============================================================================

export type ChainSyncScheduler = {
  /**
   * Per-chain sync state.
   *
   * A `SubscriptionRef`, so a consumer can follow `.changes` instead of polling it. It reads as a
   * `Ref` too, which is what every existing caller does — the difference is that the app no longer has
   * to re-serialise the whole map twice a second to notice a status flip.
   */
  readonly states: SubscriptionRef.SubscriptionRef<ReadonlyMap<ChainWalletKey, ChainSyncState>>

  /** Start sync fibers for the given chain wallets. Stops any previously running fibers. */
  readonly start: (
    chains: ReadonlyArray<{groupId: WalletGroupId; chainId: ChainId}>,
    activeGroupId: WalletGroupId | null,
    syncer: ChainSyncer,
    txChecker?: TxConfirmationChecker,
  ) => Effect.Effect<void>

  /** Stop all running sync fibers. */
  readonly stop: () => Effect.Effect<void>

  /** Boost a specific chain's sync schedule after tx submission. Stops early when txHash is confirmed. */
  readonly boostChain: (groupId: WalletGroupId, chainId: ChainId, txHash?: string) => Effect.Effect<void>

  /** Update which group is active (adjusts scheduling priority). */
  readonly setActiveGroup: (groupId: WalletGroupId | null) => Effect.Effect<void>
}

/**
 * Create a ChainSyncScheduler.
 */
export const createChainSyncScheduler = (config?: ChainSyncSchedulerConfig): Effect.Effect<ChainSyncScheduler, never> =>
  Effect.gen(function* () {
    const baseIntervalMs = config?.baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS
    const postTxIntervalMs = config?.postTxIntervalMs ?? DEFAULT_POST_TX_INTERVAL_MS
    const postTxDurationMs = config?.postTxDurationMs ?? DEFAULT_POST_TX_DURATION_MS
    const staggerMs = config?.staggerMs ?? DEFAULT_STAGGER_MS
    const backgroundMultiplier = config?.backgroundMultiplier ?? DEFAULT_BACKGROUND_MULTIPLIER
    const states = yield* SubscriptionRef.make<ReadonlyMap<ChainWalletKey, ChainSyncState>>(new Map())
    const fibers = yield* Ref.make<ReadonlyMap<ChainWalletKey, Fiber.RuntimeFiber<void, never>>>(new Map())
    const boostedChains = yield* Ref.make<ReadonlyMap<ChainWalletKey, number>>(new Map())
    const pendingTxHashes = yield* Ref.make<ReadonlyMap<ChainWalletKey, string>>(new Map())
    const activeGroup = yield* Ref.make<WalletGroupId | null>(null)
    const syncerRef = yield* Ref.make<ChainSyncer | null>(null)
    const txCheckerRef = yield* Ref.make<TxConfirmationChecker | null>(null)

    const updateChainState = (key: ChainWalletKey, update: Partial<ChainSyncState>): Effect.Effect<void> =>
      Ref.update(states, (map) => {
        const current = map.get(key) ?? {status: 'idle' as const}
        return new Map([...map, [key, {...current, ...update}]])
      })

    const stopAllFibers = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiberMap = yield* Ref.get(fibers)
        for (const fiber of fiberMap.values()) {
          yield* Fiber.interrupt(fiber)
        }
        yield* Ref.set(fibers, new Map())
      })

    const getInterval = (key: ChainWalletKey, groupId: string): Effect.Effect<number> =>
      Effect.gen(function* () {
        const boosted = yield* Ref.get(boostedChains)
        const boostExpiry = boosted.get(key)

        // Post-tx boost: aggressive polling
        if (boostExpiry != null && Date.now() < boostExpiry) {
          return postTxIntervalMs
        }

        // Clear expired boost
        if (boostExpiry != null) {
          yield* Ref.update(boostedChains, (m) => {
            const next = new Map(m)
            next.delete(key)
            return next
          })
        }

        // Background group: slower interval
        const active = yield* Ref.get(activeGroup)
        if (active != null && groupId !== active) {
          return baseIntervalMs * backgroundMultiplier
        }

        return baseIntervalMs
      })

    const createChainFiber = (
      groupId: WalletGroupId,
      chainId: ChainId,
      syncer: ChainSyncer,
    ): Effect.Effect<Fiber.RuntimeFiber<void, never>> => {
      const key = chainKey(groupId, chainId)

      const syncLoop: Effect.Effect<void, never> = Effect.gen(function* () {
        // Run sync
        yield* updateChainState(key, {status: 'syncing'})
        const result = yield* Effect.either(syncer(groupId, chainId))

        const now = Date.now()
        if (result._tag === 'Right') {
          const changed = result.right
          yield* updateChainState(key, {
            status: 'idle',
            lastSynced: now,
            ...(changed ? {lastChanged: now} : {}),
            lastError: undefined,
          })
        } else {
          yield* updateChainState(key, {
            status: 'error',
            lastSynced: now,
            lastError: result.left.message,
          })
        }

        // If boosted and watching for a tx, check if it's confirmed → cancel boost early
        const boosted = yield* Ref.get(boostedChains)
        if (boosted.has(key)) {
          const watchedHash = (yield* Ref.get(pendingTxHashes)).get(key)
          const checker = yield* Ref.get(txCheckerRef)
          if (watchedHash && checker) {
            const confirmed = yield* checker(groupId, chainId, watchedHash)
            if (confirmed) {
              yield* Ref.update(boostedChains, (m) => {
                const next = new Map(m)
                next.delete(key)
                return next
              })
              yield* Ref.update(pendingTxHashes, (m) => {
                const next = new Map(m)
                next.delete(key)
                return next
              })
            }
          }
        }

        // Wait for the adaptive interval — or until something asks this chain to wake.
        const interval = yield* getInterval(key, groupId)
        yield* sleepOrWake(key, interval)
      }).pipe(Effect.catchAll(() => Effect.sleep(baseIntervalMs)))

      // Repeat forever — the sleep inside the loop handles timing
      const repeating = Effect.repeat(syncLoop, Schedule.forever).pipe(Effect.asVoid)

      return Effect.forkDaemon(repeating)
    }

    /**
     * Per-chain wake signals.
     *
     * ⚠️ **Why not just interrupt the fiber.** A chain sleeping out a 180-second background interval
     * cannot be told "sooner" by a `Ref` — it is already parked. `boostChain` and `setActiveGroup`
     * therefore used to `Fiber.interrupt` and re-fork, which throws away the loop's place and churns a
     * fiber per boost. Racing the sleep against a `Deferred` says the same thing without either: the
     * loop wakes, re-reads `getInterval`, and carries on.
     */
    const wakeSignals = yield* Ref.make(new Map<ChainWalletKey, Deferred.Deferred<void>>())

    const signalFor = (key: ChainWalletKey): Effect.Effect<Deferred.Deferred<void>> =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(wakeSignals)).get(key)
        if (existing !== undefined) return existing
        const made = yield* Deferred.make<void>()
        yield* Ref.update(wakeSignals, (m) => new Map([...m, [key, made]]))
        return made
      })

    /** Sleep, unless woken first. The signal is discarded after, so the next wait starts fresh. */
    const sleepOrWake = (key: ChainWalletKey, duration: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const signal = yield* signalFor(key)
        yield* Effect.raceFirst(Effect.sleep(duration), Deferred.await(signal))
        yield* Ref.update(wakeSignals, (m) => {
          const next = new Map(m)
          next.delete(key)
          return next
        })
      })

    /** Ask a chain to stop waiting. A no-op when it is mid-sync rather than parked. */
    const wake = (key: ChainWalletKey): Effect.Effect<void> =>
      Effect.gen(function* () {
        const signal = (yield* Ref.get(wakeSignals)).get(key)
        if (signal !== undefined) yield* Deferred.succeed(signal, undefined)
      })

    const start: ChainSyncScheduler['start'] = (chains, initialActiveGroupId, syncer, txChecker) =>
      Effect.gen(function* () {
        yield* stopAllFibers()
        yield* Ref.set(activeGroup, initialActiveGroupId)
        yield* Ref.set(states, new Map())
        yield* Ref.set(boostedChains, new Map())
        yield* Ref.set(pendingTxHashes, new Map())
        yield* Ref.set(syncerRef, syncer)
        yield* Ref.set(txCheckerRef, txChecker ?? null)

        const fiberMap = new Map<ChainWalletKey, Fiber.RuntimeFiber<void, never>>()

        // Fork fibers with stagger — active group first
        const activeChains = chains.filter((c) => c.groupId === initialActiveGroupId)
        const otherChains = chains.filter((c) => c.groupId !== initialActiveGroupId)

        for (const chain of [...activeChains, ...otherChains]) {
          const key = chainKey(chain.groupId, chain.chainId)
          yield* updateChainState(key, {status: 'idle'})
          const fiber = yield* createChainFiber(chain.groupId, chain.chainId, syncer)
          fiberMap.set(key, fiber)
          if (staggerMs > 0) yield* Effect.sleep(staggerMs)
        }

        yield* Ref.set(fibers, fiberMap)
      })

    const stop: ChainSyncScheduler['stop'] = () => stopAllFibers()

    const boostChain: ChainSyncScheduler['boostChain'] = (groupId, chainId, txHash) =>
      Effect.gen(function* () {
        const key = chainKey(groupId, chainId)
        const expiry = Date.now() + postTxDurationMs
        yield* Ref.update(boostedChains, (m) => new Map([...m, [key, expiry]]))
        if (txHash) {
          yield* Ref.update(pendingTxHashes, (m) => new Map([...m, [key, txHash]]))
        }

        // Wake it rather than replace it: the boost is already recorded above, and `getInterval` is
        // re-read on the next turn of the loop.
        yield* wake(key)
      })

    const setActiveGroup: ChainSyncScheduler['setActiveGroup'] = (groupId) =>
      Effect.gen(function* () {
        const prev = yield* Ref.get(activeGroup)
        yield* Ref.set(activeGroup, groupId)

        // Wake the newly-active group's chains so they sync now instead of waiting out a background
        // sleep of up to 180 s. Waking rather than re-forking keeps each loop's place — and keeps a
        // chain that is *mid-sync* from being cut off halfway, which the interrupt did.
        if (groupId != null && groupId !== prev) {
          const fiberMap = yield* Ref.get(fibers)
          for (const key of fiberMap.keys()) {
            if (key.startsWith(`${groupId}:`)) yield* wake(key)
          }
        }
      })

    return {states, start, stop, boostChain, setActiveGroup}
  })
