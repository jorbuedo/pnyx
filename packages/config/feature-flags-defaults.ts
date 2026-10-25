/**
 * Static feature flag defaults for all precedence layers.
 *
 * @module
 */

import type {EnvironmentId, FeatureFlagsConfig, PlatformId} from './feature-flags.js'

/**
 * Layer 1: Code defaults - The app's baseline feature states.
 *
 * The lowest-precedence layer and the app's shipped feature set. Features the
 * app ships on are enabled here; everything dark-launched or dev-only stays
 * off until an environment / remote-config / runtime layer opts in.
 */
export const CODE_DEFAULTS: FeatureFlagsConfig = {
  // Core wallet features
  addWallet: true,

  // Onboarding flows
  createWallet: true,
  restoreWallet: true,

  // Additional features
  discover: true,
  pushNotifications: false,
  portfolioChart: false,

  // Developer tools (local-only)
  devTools: false,

  // Encrypted backup export (consumer side is always on)
  encryptedBackupExport: false,

  // Swap vertical — off at the baseline, which is what keeps it out of production while the
  // SteelSwap integration is unfinished. Dev and preview opt in below.
  swap: false,

  // Handles — off at the baseline. The launch ships nicknames only; a handle is the registered
  // presentation of the same `primaryName`, and it needs `payment.compact` deployed first.
  handles: false,

  // Phase-B on-device proving — off at the baseline until the cutover is complete.
}

/**
 * Layer 2: Platform overrides - Platform-specific availability.
 *
 * Some features only make sense on certain platforms.
 */
export const PLATFORM_OVERRIDES: Record<PlatformId, Partial<FeatureFlagsConfig>> = {
  mobile: {
    pushNotifications: true,
  },
  web: {
    pushNotifications: false,
  },
  extension: {
    pushNotifications: false,
  },
}

/**
 * Layer 3: Environment overrides.
 *
 * `development` enables most features for testing. `preview` and `production` are both deliberately
 * minimal: they list only what must differ from the code default, so a feature reaching the preview
 * build is a decision recorded here rather than a side effect of the layer being permissive.
 */
export const ENVIRONMENT_OVERRIDES: Record<EnvironmentId, Partial<FeatureFlagsConfig>> = {
  development: {
    // Core
    addWallet: true,
    // Onboarding
    createWallet: true,
    restoreWallet: true,
    // Additional
    discover: true,
    portfolioChart: true,
    devTools: true, // Dev tools always available in dev builds
    encryptedBackupExport: true, // Dev-only entrypoint; consumer side is always on
    swap: true,
    // On in dev so the claim, storefront and rebind paths stay exercisable against preprod, where
    // `payment.compact` and the handle templates are deployed.
    handles: true,
  },
  preview: {
    // Minimal, like production. Preview exists to validate what production will get, so anything
    // listed here is a deliberate "test build only" exception.
    devTools: false,
    // Reachable in preview so the vertical stays exercisable against a real build while the
    // SteelSwap integration is finished. Still subject to the network capability, which hides swap
    // on testnets — so this only shows once the tester switches to mainnet.
    swap: true,
    // Reachable in preview for the same reason as dev: the vertical is finished and a tester on
    // preprod can drive it end to end. Production ships without it.
    handles: true,
  },
  production: {
    // Production features controlled by remote config
    // Only override what should differ from code defaults
    devTools: false, // Must be explicitly enabled via 5-tap
  },
}
