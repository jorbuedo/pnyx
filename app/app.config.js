/**
 * Dynamic Expo configuration with build variants.
 *
 * Build variants (PNYX_BUILD_VARIANT):
 * - Standalone dev builds (dev, default) use the .dev app ID suffix
 * - Production builds (prod) use the standard app IDs
 * - DevClient builds (devclient) use the .devclient app ID suffix
 * - Staging builds use a matching app ID suffix
 *
 * @example
 * npx expo prebuild                          // default dev variant
 * PNYX_BUILD_VARIANT=prod npx expo prebuild // production app IDs
 * PNYX_BUILD_VARIANT=devclient npx expo prebuild
 */

const fs = require('node:fs')
const path = require('node:path')

const {KOTLIN_VERSION} = require('./plugins/with-kotlin-version')

/**
 * Reads PNYX_BUILD_VARIANT from app/.env when process.env is empty
 * or unset. Expo / dotenv on some platforms (notably Windows extension exports)
 * can leave process.env.PNYX_BUILD_VARIANT blank while still loading
 * EXPO_PUBLIC_* from the same file — which would otherwise default the build to
 * `dev` and misalign remote config (e.g. dev banner) with the API env (mainnet).
 *
 * @returns {string | undefined} trimmed value, or undefined if missing / empty / no file
 */
function readPnyxBuildVariantFromDotEnv() {
  const dotEnvPath = path.join(__dirname, '.env')
  if (!fs.existsSync(dotEnvPath)) {
    return undefined
  }
  const content = fs.readFileSync(dotEnvPath, 'utf-8').replace(/^\uFEFF/, '')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq === -1) {
      continue
    }
    const key = trimmed.slice(0, eq).trim()
    if (key !== 'PNYX_BUILD_VARIANT') {
      continue
    }
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    return value === '' ? undefined : value
  }
  return undefined
}

/**
 * Resolves the build variant from environment variables.
 *
 * The variant controls several aspects of the build beyond just the app ID suffix:
 * - App ID / package name suffix (so variants coexist with prod on device)
 * - App display name suffix
 * - Google Services file selection (Firebase project per variant)
 * - `isDevelopment` flag exposed via `extra` (affects network config, remote config selection)
 *
 * Variants:
 * - 'dev'       = standalone development build, JS bundle baked in (no Metro connection) (default)
 * - 'prod'      = production build, no suffix, isDevelopment: false
 * - 'devclient' = Expo dev-client build, connects to a running Metro server
 */
function getBuildVariant() {
  // Explicit variant always wins — checked before any EAS_BUILD_PROFILE inference.
  let variant = typeof process.env.PNYX_BUILD_VARIANT === 'string' ? process.env.PNYX_BUILD_VARIANT.trim() : ''
  if (!variant) {
    const fromDotEnv = readPnyxBuildVariantFromDotEnv()
    variant = typeof fromDotEnv === 'string' ? fromDotEnv.trim() : ''
  }
  if (variant === 'prod' || variant === 'production') {
    return 'prod'
  }
  if (variant === 'dev' || variant === 'development') {
    return 'dev'
  }
  if (variant === 'devclient') {
    return 'devclient'
  }
  // No explicit variant — fall back to EAS_BUILD_PROFILE inference.
  if (process.env.EAS_BUILD_PROFILE === 'production') {
    return 'prod'
  }
  if (process.env.EAS_BUILD_PROFILE === 'development' || process.env.EAS_BUILD_PROFILE === 'development:device') {
    return 'devclient'
  }
  if (process.env.EAS_BUILD_PROFILE === 'preview') {
    // This is specifically by request from QA
    // They want prod build variant for EAS preview
    return 'prod'
  }

  // Default to 'dev' by design — an unspecified build should never silently
  // produce a production artifact. Requiring an explicit PNYX_BUILD_VARIANT=prod
  // (or EAS_BUILD_PROFILE=production) to get a prod build prevents accidental
  // prod releases from local or CI environments that forget to set the flag.
  return 'dev'
}

// Single brand. The build-variant axis below (dev/devclient/prod) is
// independent of brand identity and drives app-id suffixing + app name.
const brand = {
  name: 'Pnyx',
  slug: 'pnyx', // EAS project slug — placeholder until the real EAS project exists
  scheme: 'pnyx',
  projectId: '00000000-0000-0000-0000-000000000000', // EAS project ID placeholder
  ios: {bundleIdentifier: 'uk.pxkq.pnyx'},
  android: {package: 'uk.pxkq.pnyx'},
  splash: {backgroundColor: '#0D0F0D'},
  adaptiveIconBackgroundColor: '#0D0F0D',
}

const buildVariant = getBuildVariant()

/**
 * Resolves the environment-tag axis (remote-config JSON, Sentry env, sample
 * rate) independently from the app-identity axis (`buildVariant`).
 *
 * `PNYX_APP_ENV` is the explicit override consumed by env files that
 * want a build to *behave* like one variant but *report* as another —
 * preview builds in particular ship with `buildVariant='prod'` (per QA
 * request, to get prod bundle IDs / icons / app name) but need
 * `appEnv='preview'` so the runtime fetches `preview.json` from the
 * remote-config repo and Sentry events land tagged `preview` (not
 * `production`) with non-zero sampling.
 *
 * Falls back to deriving from `buildVariant` so the existing path
 * (`dev`/`devclient`/`prod`) is unchanged for builds that don't set the override.
 *
 * @returns {'dev' | 'preview' | 'prod'}
 */
function getAppEnv() {
  const override = typeof process.env.PNYX_APP_ENV === 'string' ? process.env.PNYX_APP_ENV.trim() : ''
  if (override === 'dev' || override === 'preview' || override === 'prod') {
    return override
  }
  return buildVariant === 'devclient' ? 'dev' : buildVariant
}

const appEnv = getAppEnv()

/**
 * Dev-machine host for a LAN preview build (`PNYX_LAN_HOST=192.168.x.x`).
 *
 * One knob on purpose: it both opens the cleartext exception and, in the build scripts, derives
 * `EXPO_PUBLIC_SERVICE_URL`. Setting only one of those is the failure this avoids — a LAN URL with no
 * exception is blocked by the platform, and an exception with no URL points at nothing.
 *
 * Accepts `host` or `host:port`; only the host reaches the network-security config, because
 * Android's `domain-config` matches on hostname and a port there matches nothing.
 */
const LAN_HOST = (process.env.PNYX_LAN_HOST ?? '').trim().split(':')[0] || undefined

// Append variant suffix to app IDs so they can coexist with production.
const variantForIds = buildVariant === 'prod' ? undefined : buildVariant
const iosBundleId = variantForIds ? `${brand.ios.bundleIdentifier}.${variantForIds}` : brand.ios.bundleIdentifier
const androidPackage = variantForIds ? `${brand.android.package}.${variantForIds}` : brand.android.package

// Format app name based on variant
let appName = brand.name
if (buildVariant === 'dev') {
  appName = `${brand.name} Dev`
} else if (buildVariant === 'devclient') {
  appName = `${brand.name} DevClient`
}

const packageJson = require('./package.json')

/** @type {import('expo/config').ExpoConfig} */
const config = {
  name: appName,
  slug: brand.slug,
  version: packageJson.version,
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: brand.scheme,
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: brand.splash.backgroundColor,
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: iosBundleId,
    // Dev plist for dev/devclient, prod plist for prod (and prod-shaped preview
    // builds, which set buildVariant='prod' per QA request).
    googleServicesFile: buildVariant === 'prod' ? './GoogleService-Info.plist' : './GoogleService-Info.dev.plist',
    // webcredentials: enables platform passkeys (the PRF recovery rail); the
    // domain must serve /.well-known/apple-app-site-association with a
    // webcredentials section listing <TeamID>.<bundleId>.
    associatedDomains: ['applinks:pnyx.pxkq.uk', 'webcredentials:pnyx.pxkq.uk'],
    entitlements: {
      'aps-environment': buildVariant === 'prod' ? 'production' : 'development',
    },
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSCameraUsageDescription: `Allow ${appName} to use the camera to scan QR codes`,
      UIBackgroundModes: ['fetch', 'remote-notification'],
      NSUserNotificationUsageDescription: `Allow ${appName} to send you notifications about your wallet activity`,
      NSFaceIDUsageDescription: `Allow ${appName} to use Face ID to authorize transactions and access your wallet`,
      NSBluetoothAlwaysUsageDescription: `Allow ${appName} to connect to your hardware wallet over Bluetooth`,
      NSBluetoothPeripheralUsageDescription: `Allow ${appName} to connect to your hardware wallet over Bluetooth`,
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundImage: './assets/adaptive-icon-background.png',
      // No monochromeImage: it was pointed at the full-color icon, so Android's
      // themed-icon (Material You) layer desaturated the gradient into a
      // gray/B&W silhouette — the icon "flipping" to black-and-white when themed
      // icons are on. Omitting it makes the launcher always show the color icon.
      backgroundColor: brand.adaptiveIconBackgroundColor,
    },
    package: androidPackage,
    googleServicesFile:
      buildVariant === 'dev' || buildVariant === 'devclient' ? './google-services.dev.json' : './google-services.json',
    // Only list permissions NOT already declared by a library's AndroidManifest
    // or by an Expo config plugin. Re-declaring a permission here without
    // matching attributes (e.g. maxSdkVersion, neverForLocation) produces a
    // duplicate <uses-permission> in the merged manifest, which Play Store
    // rejects on AAB upload. See docs/PERMISSIONS.md for the full inventory
    // and rules for adding new ones.
    permissions: [],
    intentFilters: [
      {
        action: 'VIEW',
        data: [{scheme: brand.scheme}],
        category: ['DEFAULT', 'BROWSABLE'],
      },
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{scheme: 'https', host: 'pnyx.pxkq.uk', pathPrefix: '/w1'}],
        category: ['DEFAULT', 'BROWSABLE'],
      },
    ],
  },
  updates: {
    enabled: true,
    url: `https://u.expo.dev/${brand.projectId}`,
    // Manual update flow: the `useExpoOTAUpdate` hook drives check / fetch /
    // reload from JS so the user sees the explicit "Updating" overlay. Leaving
    // checkAutomatically at the 'ON_LOAD' default lets the native side race
    // with our hook and silently swap bundles between launches, which masks
    // the overlay.
    checkAutomatically: 'NEVER',
    fallbackToCacheTimeout: 0,
  },
  runtimeVersion: {
    policy: 'appVersion',
  },
  web: {
    bundler: 'metro',
    output: 'single',
    favicon: './assets/favicon.png',
  },
  extra: {
    // 'appEnv' is the normalized environment exposed to the runtime bundle.
    // Always a valid RemoteConfigEnv: 'dev' | 'preview' | 'prod'.
    // Resolved by `getAppEnv()`, which prefers an explicit `PNYX_APP_ENV`
    // override (used by `.env.preview` to ship a prod-shaped artifact that
    // still reports as preview for telemetry / remote-config purposes) and
    // falls back to `buildVariant` otherwise.
    appEnv,
    isDevelopment: buildVariant === 'dev' || buildVariant === 'devclient',
    router: {
      origin: false,
    },
    eas: {
      projectId: brand.projectId,
    },
  },
  plugins: [
    // Included ONLY when an auth token exists. Without one the plugin still adds a
    // sentry-cli source-map upload to the release build, which fails the whole build —
    // no Sentry org is configured for this project yet (the `pnyx` / `pnyx-*` names
    // below are placeholders, like the EAS projectId above). Set SENTRY_AUTH_TOKEN once
    // a real org exists and this switches itself back on.
    ...(process.env.SENTRY_AUTH_TOKEN
      ? [
          [
            '@sentry/react-native/expo',
            {
              url: 'https://sentry.io/',
              // Source-map upload target follows `appEnv`, not `buildVariant` —
              // otherwise preview builds (`buildVariant='prod'`, `appEnv='preview'`)
              // would upload maps to the production project while their runtime
              // DSN points to the dev project, leaving every preview event
              // unsymbolicated.
              project: appEnv === 'prod' ? 'pnyx-production' : 'pnyx-dev',
              organization: 'pnyx',
            },
          ],
        ]
      : []),
    'expo-router',
    'expo-asset',
    'expo-updates',
    'expo-web-browser',
    [
      'expo-dev-client',
      {
        // SDK 56's expo-dev-launcher dropped the implicit localhost fallback — without
        // DEV_CLIENT_DEFAULT_LAUNCHER_URL, fresh installs always boot into the launcher UI
        // (recentlyOpenedAppsRegistry is empty after `prebuild --clean`). Bake the loopback
        // URL so sim/emu builds auto-connect to Metro. Physical-device dev still overrides
        // via the deep link generated by scripts/start-dev.ts.
        ios: {defaultLaunchURL: 'http://localhost:8081'},
        android: {defaultLaunchURL: 'http://10.0.2.2:8081'},
      },
    ],
    'expo-camera',
    '@react-native-firebase/app',
    '@react-native-firebase/messaging',
    './plugins/with-firebase-modular-headers',
    './plugins/with-notifee-android-maven',
    './plugins/with-fcm-default-channel',
    './plugins/with-fcm-notification-icon',
    './plugins/with-main-activity-launch-mode',
    './plugins/with-android-disable-backup',
    './plugins/with-ios-disable-backup',
    './plugins/with-cocoapods-git-source',
    './plugins/with-pods-deployment-target',
    [
      'react-native-ble-plx',
      {
        neverForLocation: true,
      },
    ],
    './plugins/with-ble-location-permissions',
    './plugins/with-bluetooth-legacy-max-sdk',
    './plugins/with-gradle-jvm-heap',
    './plugins/with-kotlin-version',
    './plugins/with-release-signing',
    // Inert unless PNYX_LAN_HOST is set. Lets a release-shaped build reach a service on the dev
    // machine over plain HTTP, which the platform otherwise blocks outright — scoped to that one
    // host, so nothing else in the app gains cleartext permission. See the plugin's header.
    ...(LAN_HOST ? [['./plugins/with-lan-cleartext', {host: LAN_HOST}]] : []),
    [
      'expo-build-properties',
      {
        android: {
          ndkVersion: '27.0.12077973',
          // Must match the version `with-kotlin-version` forces on the root buildscript: this
          // half only moves `ext.kotlinVersion` and the KSP version derived from it.
          kotlinVersion: KOTLIN_VERSION,
          // Android 8.0. Raised from Expo's default 24 because ML Kit GenAI
          // (`@pnyx/model-native`) declares minSdk 26 and the manifest merge fails
          // otherwise. `tools:overrideLibrary` was the alternative and was rejected: it
          // suppresses the check but risks class-load crashes on the very devices it
          // pretends to support.
          minSdkVersion: 26,
        },
        ios: {
          useFrameworks: 'static',
          // RNFB pods #import non-modular React-Core headers, which can't compile as
          // framework modules on SDK 55 (prebuilt React-Core); link them as static
          // libraries instead. See expo/expo#39607.
          forceStaticLinking: ['RNFBApp', 'RNFBMessaging'],
          deploymentTarget: '16.4',
        },
      },
    ],
    [
      'expo-font',
      {
        fonts: [
          './assets/fonts/Inter-Regular.ttf',
          './assets/fonts/Inter-Medium.ttf',
          './assets/fonts/Inter-SemiBold.ttf',
          './assets/fonts/Inter-Bold.ttf',
        ],
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
}

module.exports = {expo: config}
