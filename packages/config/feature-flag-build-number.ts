/**
 * Build-number-range helper for feature flags.
 *
 * Build numbers are monotonically-increasing integers managed by EAS Build
 * (iOS `CFBundleVersion`, Android `versionCode`). Comparing them is a plain
 * integer check — no SemVer parsing, no pre-release suffixes to worry about,
 * no ambiguous ordering. The wallet exposes the current value via
 * `expo-application`'s `nativeBuildVersion`.
 *
 * @module
 */

import type {FeatureFlagValue} from './feature-flags.js'

/**
 * Decide whether a flag value's build-number constraints (if any) match the
 * running app's build number.
 *
 * Returns `true` for:
 *  - Plain boolean values (no version constraint possible).
 *  - Object values with no `minBuildNumber` / `maxBuildNumber`.
 *  - Object values whose constraints include the current build number.
 *
 * Returns `false` when the value declares a min/max bound that the running
 * build sits outside of — the evaluator treats this layer as undefined and
 * falls through to the next.
 *
 * A `buildNumber` of `0` (or any non-finite number) is treated as "unknown"
 * and the layer applies (fail-open). This covers dev / Expo Go runs where
 * the native build version isn't populated.
 */
export const valueAppliesToBuildNumber = (value: FeatureFlagValue, buildNumber: number): boolean => {
  if (typeof value === 'boolean') return true
  if (!Number.isFinite(buildNumber) || buildNumber <= 0) return true
  if (value.minBuildNumber !== undefined && buildNumber < value.minBuildNumber) return false
  if (value.maxBuildNumber !== undefined && buildNumber > value.maxBuildNumber) return false
  return true
}
