/**
 * Feature flags system for runtime feature toggles.
 *
 * Supports six layers of precedence (highest to lowest):
 * 6. Runtime Override - Dev mode 5-tap toggle (persisted to storage)
 * 5. Remote Config - Fetched from the remote-config repo
 * 4. Brand Config - Per-brand feature configuration
 * 3. Environment - Development vs Production
 * 2. Platform - Mobile vs Extension vs Web
 * 1. Code Defaults - Hardcoded baseline
 *
 * @module
 */

/**
 * All feature flag identifiers.
 */
export type FeatureFlagId =
  // Core wallet features
  | 'addWallet'
  // Onboarding flows
  | 'createWallet'
  | 'restoreWallet'
  // Additional features
  | 'discover'
  | 'pushNotifications'
  // Show portfolio / per-asset / row sparkline charts.
  | 'portfolioChart'
  // Developer tools (local-only, not in remote config)
  | 'devTools'
  // Encrypted backup export — surfaces the "Encrypted backup" affordance on
  // the recovery-phrase screen. The deeplink consumer side is always on.
  | 'encryptedBackupExport'
  // Swap vertical. Held off production while the SteelSwap integration is unfinished; on in dev and
  // preview so it stays exercisable. ANDed with the network capability, which already hides swap on
  // testnets, so this is a build-variant gate rather than a second copy of that rule.
  | 'swap'
  // Pnyx handles — claiming a name on chain, the permit storefront, tiers, rebind and release.
  //
  // Off for the mainnet launch, which ships the nickname layer alone: `identity(C).primaryName`
  // always renders, and a handle is the *registered* presentation of the same name. Handles need
  // `payment.compact` deployed before any handle template can exist (its address seals into every
  // one of them), and that deploy carries the decisions that can never be revised — permit expiry,
  // both sealed treasuries, the launch currency, the tier boundaries. Flagging the vertical off is
  // what takes all of that off the launch path.
  //
  // ⚠️ Off is not dead: the machinery is complete and was device-verified against preprod, so dev
  // and preview opt in below to keep it exercisable rather than letting it rot. Same posture as
  // `swap`.
  | 'handles'
// Phase-B on-device proving: when on, forum actions (join, …) build + prove their contract tx
// natively on the device and POST it to /chain/submit, instead of the interim server-side rail.

/**
 * Feature flag value can be a simple boolean or a rollout object.
 *
 * `minBuildNumber` / `maxBuildNumber` scope this layer's value to a
 * build-number range (iOS `CFBundleVersion`, Android `versionCode`).
 * When the running app's build number is OUTSIDE the range, this layer
 * is treated as undefined and the evaluator falls through to the next
 * lower layer. Combined with code default `false`, a remote-config
 * `{enabled: true, minBuildNumber: 42}` means "on for build 42 and
 * later, off for older builds" — without forcing a rebuild to roll
 * back.
 */
export type FeatureFlagValue =
  | boolean
  | {
      /** Whether the feature is enabled at all */
      readonly enabled: boolean
      /** Percentage of users to enable for (0-100), requires installation ID */
      readonly rolloutPercentage?: number
      /** Inclusive lower bound on the running app's build number */
      readonly minBuildNumber?: number
      /** Inclusive upper bound on the running app's build number */
      readonly maxBuildNumber?: number
    }

/**
 * Configuration mapping of feature flag IDs to their values.
 */
export type FeatureFlagsConfig = Partial<Record<FeatureFlagId, FeatureFlagValue>>

/**
 * Runtime override stored in persistent storage.
 */
export type RuntimeOverride = {
  /** Feature flag ID */
  readonly flagId: FeatureFlagId
  /** Override value (true/false) */
  readonly enabled: boolean
  /** When this override was set */
  readonly setAt: number
  /** Optional expiration timestamp (ms since epoch) */
  readonly expiresAt?: number
}

/**
 * Storage format for runtime overrides.
 */
export type RuntimeOverridesStorage = {
  readonly overrides: readonly RuntimeOverride[]
}

/**
 * Platform identifier.
 */
export type PlatformId = 'mobile' | 'web' | 'extension'

/**
 * Environment identifier.
 */
/**
 * Which environment's override layer applies.
 *
 * ⚠️ **Three values, and `preview` is not an alias for either neighbour.** It used to be folded into
 * `production`, on the correct reasoning that mapping it to `development` would blanket-enable every
 * flag and defeat the point of preview validation. Its own layer keeps that property — the map below
 * is as minimal as production's — while letting a feature be on in preview and off in prod, which is
 * the ordinary shape of "ship it to the test build first" and was previously inexpressible in code.
 */
export type EnvironmentId = 'development' | 'preview' | 'production'

/**
 * Source of a feature flag evaluation.
 */
export type FeatureFlagSource = 'runtime' | 'remote' | 'environment' | 'platform' | 'code'

/**
 * Result of evaluating a feature flag.
 */
export type FeatureFlagEvaluation = {
  /** Feature flag ID */
  readonly flagId: FeatureFlagId
  /** Whether the feature is enabled */
  readonly enabled: boolean
  /** Source that determined this value */
  readonly source: FeatureFlagSource
  /** When this was evaluated */
  readonly evaluatedAt: number
}

/**
 * Audit trail entry for debugging.
 */
export type FeatureFlagAuditEntry = FeatureFlagEvaluation
