/**
 * React hooks for feature flags.
 *
 * @module
 */

import type {FeatureFlagEvaluation, FeatureFlagId} from '@pnyx/config'
import {Effect} from 'effect'
import {useEffect, useRef, useState} from 'react'

import {logger} from '../logger'
import {useConfig} from '../providers/ConfigProvider'

/**
 * Hook to check if a feature flag is enabled.
 *
 * Subscribes to changes and re-renders when the flag value changes.
 *
 * @param flagId - Feature flag to check
 * @returns Boolean indicating if the feature is enabled, or false if service not initialized
 *
 * @example
 * ```tsx
 * function DiscoverGrid() {
 *   const discoverEnabled = useFeatureFlag('discover')
 *
 *   if (!discoverEnabled) {
 *     return <ComingSoonScreen />
 *   }
 *
 *   return <DiscoverTiles />
 * }
 * ```
 */
export function useFeatureFlag(flagId: FeatureFlagId): boolean {
  const {featureFlagsService, isFeatureFlagsLoading} = useConfig()
  const [enabled, setEnabled] = useState(false)
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined)

  useEffect(() => {
    if (!featureFlagsService) {
      setEnabled(false)
      return
    }

    let mounted = true

    // Combine initial value fetch and subscription into single Effect
    Effect.runPromise(
      Effect.gen(function* () {
        // Get initial value first
        const initial = yield* featureFlagsService.isEnabled(flagId)
        if (mounted) setEnabled(initial)

        // Then subscribe to changes
        const unsub = yield* featureFlagsService.subscribe(flagId, (_: FeatureFlagId, newEnabled: boolean) => {
          if (mounted) setEnabled(newEnabled)
        })
        return unsub
      }),
    )
      .then((unsub) => {
        if (mounted) {
          unsubscribeRef.current = unsub
        } else {
          // Component unmounted before subscription resolved — clean up immediately
          unsub()
        }
      })
      .catch((error) => {
        if (mounted) {
          logger.error(`[useFeatureFlag] Error for flag ${flagId}`, {origin: 'useFeatureFlag', cause: error})
          setEnabled(false)
        }
      })

    return () => {
      mounted = false
      unsubscribeRef.current?.()
    }
  }, [featureFlagsService, flagId])

  // Return false while loading
  if (isFeatureFlagsLoading) {
    return false
  }

  return enabled
}

/**
 * Hook to get full feature flag evaluation with metadata.
 *
 * Useful for debugging or showing which layer determined the flag value.
 *
 * @param flagId - Feature flag to evaluate
 * @returns Evaluation result with enabled state, source, and loading flag
 *
 * @example
 * ```tsx
 * function DebugPanel() {
 *   const {enabled, source, loading} = useFeatureFlagEvaluation('discover')
 *
 *   if (loading) return <Spinner />
 *
 *   return (
 *     <View>
 *       <Text>Discover: {enabled ? 'Enabled' : 'Disabled'}</Text>
 *       <Text>Source: {source}</Text>
 *     </View>
 *   )
 * }
 * ```
 */
export function useFeatureFlagEvaluation(flagId: FeatureFlagId): {
  enabled: boolean
  source: FeatureFlagEvaluation['source']
  loading: boolean
} {
  const {featureFlagsService, isFeatureFlagsLoading} = useConfig()
  const [evaluation, setEvaluation] = useState<FeatureFlagEvaluation | null>(null)
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined)

  useEffect(() => {
    if (!featureFlagsService) {
      setEvaluation(null)
      return
    }

    let mounted = true

    // Combine initial evaluation and subscription into single Effect
    Effect.runPromise(
      Effect.gen(function* () {
        // Get initial evaluation first
        const initial = yield* featureFlagsService.evaluate(flagId)
        if (mounted) setEvaluation(initial)

        // Then subscribe to changes
        const unsub = yield* featureFlagsService.subscribe(flagId, () => {
          // Re-evaluate when flag changes
          Effect.runPromise(featureFlagsService.evaluate(flagId))
            .then((evaluation) => {
              if (mounted) setEvaluation(evaluation)
            })
            .catch((error) => {
              logger.error(`[useFeatureFlagEvaluation] Failed to re-evaluate ${flagId}`, {
                origin: 'useFeatureFlagEvaluation',
                cause: error,
              })
            })
        })
        return unsub
      }),
    )
      .then((unsub) => {
        if (mounted) {
          unsubscribeRef.current = unsub
        } else {
          unsub()
        }
      })
      .catch((error) => {
        if (mounted) {
          logger.error(`[useFeatureFlagEvaluation] Error for flag ${flagId}`, {
            origin: 'useFeatureFlagEvaluation',
            cause: error,
          })
          setEvaluation(null)
        }
      })

    return () => {
      mounted = false
      unsubscribeRef.current?.()
    }
  }, [featureFlagsService, flagId])

  if (isFeatureFlagsLoading || !evaluation) {
    return {enabled: false, source: 'code', loading: true}
  }

  return {
    enabled: evaluation.enabled,
    source: evaluation.source,
    loading: false,
  }
}
