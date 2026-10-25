/**
 * Feature flags Effect service for runtime feature toggle management.
 *
 * @module
 */

import {Context, Effect, Layer, Ref} from 'effect'
import type {
  EnvironmentId,
  FeatureFlagAuditEntry,
  FeatureFlagEvaluation,
  FeatureFlagId,
  FeatureFlagsConfig,
  PlatformId,
  RuntimeOverride,
  RuntimeOverridesStorage,
} from './feature-flags.js'
import {cleanExpiredOverrides, type EvaluationContext, evaluateFeatureFlag} from './feature-flags-evaluation.js'

/**
 * Storage key for runtime overrides.
 */
const STORAGE_KEY_OVERRIDES = '@pnyx/feature-flags-overrides'

/**
 * Maximum number of audit trail entries to keep in memory.
 */
const MAX_AUDIT_TRAIL_SIZE = 100

/**
 * Listener callback for feature flag changes.
 */
export type FeatureFlagListener = (flagId: FeatureFlagId, enabled: boolean) => void

/**
 * Feature flags service type.
 */
export type FeatureFlagsService = {
  /**
   * Check if a feature flag is enabled.
   *
   * @param flagId - Feature flag to check
   * @returns Effect yielding true if enabled
   */
  readonly isEnabled: (flagId: FeatureFlagId) => Effect.Effect<boolean>

  /**
   * Evaluate a feature flag with full metadata.
   *
   * @param flagId - Feature flag to evaluate
   * @returns Effect yielding full evaluation result
   */
  readonly evaluate: (flagId: FeatureFlagId) => Effect.Effect<FeatureFlagEvaluation>

  /**
   * Set a runtime override for a feature flag (dev mode).
   *
   * @param flagId - Feature flag to override
   * @param enabled - Override value
   * @param expiresAt - Optional expiration timestamp
   * @returns Effect that persists the override
   */
  readonly setRuntimeOverride: (flagId: FeatureFlagId, enabled: boolean, expiresAt?: number) => Effect.Effect<void>

  /**
   * Clear a runtime override for a feature flag.
   *
   * @param flagId - Feature flag to clear override for
   * @returns Effect that removes the override
   */
  readonly clearRuntimeOverride: (flagId: FeatureFlagId) => Effect.Effect<void>

  /**
   * Clear all runtime overrides.
   *
   * @returns Effect that removes all overrides
   */
  readonly clearAllRuntimeOverrides: () => Effect.Effect<void>

  /**
   * Subscribe to changes for a specific feature flag.
   *
   * @param flagId - Feature flag to watch
   * @param listener - Callback invoked when flag changes
   * @returns Effect yielding unsubscribe function
   */
  readonly subscribe: (flagId: FeatureFlagId, listener: FeatureFlagListener) => Effect.Effect<() => void>

  /**
   * Get the current audit trail.
   *
   * @returns Effect yielding recent evaluations
   */
  readonly getAuditTrail: () => Effect.Effect<readonly FeatureFlagAuditEntry[]>

  /**
   * Update the remote config feature flags.
   *
   * @param remoteConfig - New remote config
   * @returns Effect that updates the service state
   */
  readonly updateRemoteConfig: (remoteConfig: FeatureFlagsConfig | undefined) => Effect.Effect<void>
}

/**
 * Feature flags service tag for dependency injection.
 */
export const FeatureFlagsService = Context.GenericTag<FeatureFlagsService>('@pnyx/FeatureFlagsService')

/**
 * Service state stored in Refs.
 */
type ServiceState = {
  readonly platform: PlatformId
  readonly environment: EnvironmentId
  readonly installationId: string
  readonly buildNumber: number
  readonly storage: Storage
  readonly overridesRef: Ref.Ref<readonly RuntimeOverride[]>
  readonly remoteConfigRef: Ref.Ref<FeatureFlagsConfig | undefined>
  readonly auditTrailRef: Ref.Ref<readonly FeatureFlagAuditEntry[]>
  readonly listenersRef: Ref.Ref<Map<FeatureFlagId, Set<FeatureFlagListener>>>
}

/**
 * Storage abstraction (matches browser/React Native AsyncStorage API).
 */
type Storage = {
  readonly getItem: (key: string) => Promise<string | null>
  readonly setItem: (key: string, value: string) => Promise<void>
  readonly removeItem: (key: string) => Promise<void>
}

/**
 * Options for creating the feature flags service.
 */
export type FeatureFlagsServiceOptions = {
  readonly platform: PlatformId
  readonly environment: EnvironmentId
  readonly installationId: string
  /** Running app's native build number, passed to the evaluator for per-layer build-number gating */
  readonly buildNumber: number
  readonly storage: Storage
  readonly remoteConfig: FeatureFlagsConfig | undefined
}

/**
 * Load runtime overrides from storage.
 */
const loadOverrides = (storage: Storage): Effect.Effect<readonly RuntimeOverride[]> =>
  Effect.tryPromise({
    try: async () => {
      const json = await storage.getItem(STORAGE_KEY_OVERRIDES)
      if (!json) return []
      const parsed = JSON.parse(json) as RuntimeOverridesStorage
      return cleanExpiredOverrides(parsed.overrides)
    },
    catch: (error) => {
      console.error('[FeatureFlagsService] Failed to load overrides:', error)
      return []
    },
  }).pipe(Effect.orElseSucceed(() => []))

/**
 * Save runtime overrides to storage.
 */
const saveOverrides = (storage: Storage, overrides: readonly RuntimeOverride[]): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      const cleaned = cleanExpiredOverrides(overrides)
      const data: RuntimeOverridesStorage = {overrides: cleaned}
      await storage.setItem(STORAGE_KEY_OVERRIDES, JSON.stringify(data))
    },
    catch: (error) => {
      console.error('[FeatureFlagsService] Failed to save overrides:', error)
    },
  }).pipe(Effect.orElseSucceed(() => undefined))

/**
 * Add an entry to the audit trail, keeping only the last MAX_AUDIT_TRAIL_SIZE entries.
 */
const addAuditEntry = (
  auditTrailRef: Ref.Ref<readonly FeatureFlagAuditEntry[]>,
  entry: FeatureFlagAuditEntry,
): Effect.Effect<void> =>
  Ref.update(auditTrailRef, (trail) => {
    const newTrail = [...trail, entry]
    return newTrail.length > MAX_AUDIT_TRAIL_SIZE ? newTrail.slice(-MAX_AUDIT_TRAIL_SIZE) : newTrail
  })

/**
 * Notify listeners for a specific flag.
 */
const notifyListeners = (
  listenersRef: Ref.Ref<Map<FeatureFlagId, Set<FeatureFlagListener>>>,
  flagId: FeatureFlagId,
  enabled: boolean,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const listeners = yield* Ref.get(listenersRef)
    const flagListeners = listeners.get(flagId)
    if (flagListeners) {
      for (const listener of flagListeners) {
        try {
          listener(flagId, enabled)
        } catch (error) {
          console.error(`[FeatureFlagsService] Listener error for ${flagId}:`, error)
        }
      }
    }
  })

/**
 * Create the feature flags service implementation.
 */
const makeService = (state: ServiceState): FeatureFlagsService => {
  // Extract evaluate as a shared function to avoid circular dependency
  const evaluateFlag = (flagId: FeatureFlagId): Effect.Effect<FeatureFlagEvaluation> =>
    Effect.gen(function* () {
      const overrides = yield* Ref.get(state.overridesRef)
      const remoteConfig = yield* Ref.get(state.remoteConfigRef)

      const context: EvaluationContext = {
        platform: state.platform,
        environment: state.environment,
        installationId: state.installationId,
        buildNumber: state.buildNumber,
        runtimeOverrides: overrides,
        remoteConfig,
      }

      const evaluation = evaluateFeatureFlag(flagId, context)

      // Log evaluation
      console.debug(`[FeatureFlagsService] ${flagId} = ${evaluation.enabled} (source: ${evaluation.source})`)

      // Add to audit trail
      yield* addAuditEntry(state.auditTrailRef, evaluation)

      return evaluation
    })

  return {
    isEnabled: (flagId) => Effect.map(evaluateFlag(flagId), (e) => e.enabled),

    evaluate: evaluateFlag,

    setRuntimeOverride: (flagId, enabled, expiresAt) =>
      Effect.gen(function* () {
        const overrides = yield* Ref.get(state.overridesRef)

        const newOverride: RuntimeOverride = {
          flagId,
          enabled,
          setAt: Date.now(),
          ...(expiresAt !== undefined && {expiresAt}),
        }

        // Remove existing override for this flag
        const filtered = overrides.filter((o) => o.flagId !== flagId)
        const newOverrides = [...filtered, newOverride]

        yield* Ref.set(state.overridesRef, newOverrides)
        yield* saveOverrides(state.storage, newOverrides)

        console.info(`[FeatureFlagsService] Runtime override set: ${flagId} = ${enabled}`)

        // Notify listeners
        yield* notifyListeners(state.listenersRef, flagId, enabled)
      }),

    clearRuntimeOverride: (flagId) =>
      Effect.gen(function* () {
        const overrides = yield* Ref.get(state.overridesRef)
        const newOverrides = overrides.filter((o) => o.flagId !== flagId)

        yield* Ref.set(state.overridesRef, newOverrides)
        yield* saveOverrides(state.storage, newOverrides)

        console.info(`[FeatureFlagsService] Runtime override cleared: ${flagId}`)

        // Re-evaluate and notify listeners with new value
        const evaluation = yield* evaluateFlag(flagId)
        yield* notifyListeners(state.listenersRef, flagId, evaluation.enabled)
      }),

    clearAllRuntimeOverrides: () =>
      Effect.gen(function* () {
        const overrides = yield* Ref.get(state.overridesRef)
        const flagIds = overrides.map((o) => o.flagId)

        yield* Ref.set(state.overridesRef, [])
        yield* saveOverrides(state.storage, [])

        console.info('[FeatureFlagsService] All runtime overrides cleared')

        // Re-evaluate and notify all affected flags
        for (const flagId of flagIds) {
          const evaluation = yield* evaluateFlag(flagId)
          yield* notifyListeners(state.listenersRef, flagId, evaluation.enabled)
        }
      }),

    subscribe: (flagId, listener) =>
      Effect.gen(function* () {
        // Atomically add listener with immutable Map/Set updates
        yield* Ref.update(state.listenersRef, (listeners) => {
          const newListeners = new Map(listeners)
          const flagListeners = newListeners.get(flagId) ?? new Set()
          const newFlagListeners = new Set(flagListeners)
          newFlagListeners.add(listener)
          newListeners.set(flagId, newFlagListeners)
          return newListeners
        })

        // Return unsubscribe function
        return () => {
          Effect.runSync(
            Ref.update(state.listenersRef, (listeners) => {
              const newListeners = new Map(listeners)
              const flagListeners = newListeners.get(flagId)

              if (flagListeners) {
                const newFlagListeners = new Set(flagListeners)
                newFlagListeners.delete(listener)

                if (newFlagListeners.size === 0) {
                  newListeners.delete(flagId)
                } else {
                  newListeners.set(flagId, newFlagListeners)
                }
              }

              return newListeners
            }),
          )
        }
      }),

    getAuditTrail: () => Ref.get(state.auditTrailRef),

    updateRemoteConfig: (remoteConfig) =>
      Effect.gen(function* () {
        yield* Ref.set(state.remoteConfigRef, remoteConfig)
        console.info('[FeatureFlagsService] Remote config updated')

        // Re-evaluate and notify all subscribed flags
        const listeners = yield* Ref.get(state.listenersRef)
        for (const flagId of listeners.keys()) {
          const evaluation = yield* evaluateFlag(flagId)
          yield* notifyListeners(state.listenersRef, flagId, evaluation.enabled)
        }
      }),
  }
}

/**
 * Create a feature flags service layer.
 *
 * @param options - Service configuration
 * @returns Effect Layer providing FeatureFlagsService
 */
export const createFeatureFlagsServiceLayer = (options: FeatureFlagsServiceOptions): Layer.Layer<FeatureFlagsService> =>
  Layer.effect(FeatureFlagsService, createFeatureFlagsService(options))

/**
 * Create a feature flags service directly (no Layer).
 *
 * This is a convenience function for React usage where we don't need the full Layer system.
 *
 * @param options - Service configuration
 * @returns Effect yielding FeatureFlagsService
 */
export const createFeatureFlagsService = (options: FeatureFlagsServiceOptions): Effect.Effect<FeatureFlagsService> =>
  Effect.gen(function* () {
    // Load initial state
    const overrides = yield* loadOverrides(options.storage)

    // Create refs
    const overridesRef = yield* Ref.make(overrides)
    const remoteConfigRef = yield* Ref.make(options.remoteConfig)
    const auditTrailRef = yield* Ref.make<readonly FeatureFlagAuditEntry[]>([])
    const listenersRef = yield* Ref.make(new Map<FeatureFlagId, Set<FeatureFlagListener>>())

    const state: ServiceState = {
      platform: options.platform,
      environment: options.environment,
      installationId: options.installationId,
      buildNumber: options.buildNumber,
      storage: options.storage,
      overridesRef,
      remoteConfigRef,
      auditTrailRef,
      listenersRef,
    }

    return makeService(state)
  })
