/**
 * Feature flag evaluation logic with five-layer precedence.
 *
 * @module
 */

import {valueAppliesToBuildNumber} from './feature-flag-build-number.js'
import type {
  EnvironmentId,
  FeatureFlagEvaluation,
  FeatureFlagId,
  FeatureFlagsConfig,
  FeatureFlagValue,
  PlatformId,
  RuntimeOverride,
} from './feature-flags.js'
import {CODE_DEFAULTS, ENVIRONMENT_OVERRIDES, PLATFORM_OVERRIDES} from './feature-flags-defaults.js'

/**
 * Context required for feature flag evaluation.
 */
export type EvaluationContext = {
  /** Current platform */
  readonly platform: PlatformId
  /** Current environment */
  readonly environment: EnvironmentId
  /** Installation ID for consistent rollout hashing */
  readonly installationId: string
  /** Running app's native build number — used by per-layer minBuildNumber / maxBuildNumber gates */
  readonly buildNumber: number
  /** Runtime overrides from dev mode */
  readonly runtimeOverrides: readonly RuntimeOverride[]
  /** Remote config feature flags */
  readonly remoteConfig: FeatureFlagsConfig | undefined
}

/**
 * Hash a string to a number between 0-99 for consistent percentage rollouts.
 *
 * Uses a simple hash function (DJB2) for deterministic results.
 *
 * @param str - String to hash (typically `flagId:installationId`)
 * @returns Number between 0-99
 */
const hashToPercentage = (str: string): number => {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i)
  }
  return Math.abs(hash % 100)
}

/**
 * Resolve a feature flag value to a boolean, considering rollout percentage.
 *
 * @param value - Feature flag value (boolean or object)
 * @param installationId - Installation ID for rollout hashing
 * @param flagId - Flag identifier to ensure independent rollout populations per flag
 * @returns Boolean indicating if feature is enabled
 */
export const resolveFeatureFlagValue = (value: FeatureFlagValue, installationId: string, flagId: string): boolean => {
  if (typeof value === 'boolean') {
    return value
  }

  // Object with enabled + optional rolloutPercentage
  if (!value.enabled) {
    return false
  }

  // If no rollout percentage specified, it's fully enabled
  if (value.rolloutPercentage === undefined) {
    return true
  }

  // Check if this installation falls within the rollout percentage
  const userPercentile = hashToPercentage(`${flagId}:${installationId}`)
  return userPercentile < value.rolloutPercentage
}

/**
 * Evaluate a feature flag using the five-layer precedence system.
 *
 * Precedence (highest to lowest):
 * 5. Runtime Override
 * 4. Remote Config
 * 3. Environment
 * 2. Platform
 * 1. Code Defaults
 *
 * @param flagId - Feature flag to evaluate
 * @param context - Evaluation context
 * @returns Evaluation result with enabled state and source
 */
/**
 * A layer "applies" when it defines a value AND the value's optional
 * build-number constraints include the running build. Runtime overrides
 * have no build-number constraints; every other layer accepts a value
 * object with `minBuildNumber` / `maxBuildNumber`.
 */
const layerApplies = (value: FeatureFlagValue | undefined, buildNumber: number): value is FeatureFlagValue =>
  value !== undefined && valueAppliesToBuildNumber(value, buildNumber)

export const evaluateFeatureFlag = (flagId: FeatureFlagId, context: EvaluationContext): FeatureFlagEvaluation => {
  const now = Date.now()

  // Layer 5: Runtime Override (highest priority) — no build-number gating;
  // if ops/the user set an override it should win regardless of build.
  const runtimeOverride = context.runtimeOverrides.find(
    (override) => override.flagId === flagId && (!override.expiresAt || override.expiresAt > now),
  )
  if (runtimeOverride) {
    return {
      flagId,
      enabled: runtimeOverride.enabled,
      source: 'runtime',
      evaluatedAt: now,
    }
  }

  // Layer 4: Remote Config
  const remoteValue = context.remoteConfig?.[flagId]
  if (layerApplies(remoteValue, context.buildNumber)) {
    return {
      flagId,
      enabled: resolveFeatureFlagValue(remoteValue, context.installationId, flagId),
      source: 'remote',
      evaluatedAt: now,
    }
  }

  // Layer 3: Environment
  const envValue = ENVIRONMENT_OVERRIDES[context.environment]?.[flagId]
  if (layerApplies(envValue, context.buildNumber)) {
    return {
      flagId,
      enabled: resolveFeatureFlagValue(envValue, context.installationId, flagId),
      source: 'environment',
      evaluatedAt: now,
    }
  }

  // Layer 2: Platform
  const platformValue = PLATFORM_OVERRIDES[context.platform]?.[flagId]
  if (layerApplies(platformValue, context.buildNumber)) {
    return {
      flagId,
      enabled: resolveFeatureFlagValue(platformValue, context.installationId, flagId),
      source: 'platform',
      evaluatedAt: now,
    }
  }

  // Layer 1: Code Defaults (lowest priority). Build-number gating still
  // applies — a code default with an unmatched build range degrades to
  // plain `false` so the absence is well-defined.
  const codeValue = CODE_DEFAULTS[flagId]
  if (layerApplies(codeValue, context.buildNumber)) {
    return {
      flagId,
      enabled: resolveFeatureFlagValue(codeValue, context.installationId, flagId),
      source: 'code',
      evaluatedAt: now,
    }
  }
  return {
    flagId,
    enabled: false,
    source: 'code',
    evaluatedAt: now,
  }
}

/**
 * Clean up expired runtime overrides.
 *
 * @param overrides - Current runtime overrides
 * @returns Filtered overrides with expired ones removed
 */
export const cleanExpiredOverrides = (overrides: readonly RuntimeOverride[]): readonly RuntimeOverride[] => {
  const now = Date.now()
  return overrides.filter((override) => !override.expiresAt || override.expiresAt > now)
}
