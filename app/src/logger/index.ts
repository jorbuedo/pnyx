/**
 * App logger initialization with Sentry integration.
 *
 * Sentry SDK is bifurcated by platform via `./sentry-sdk`:
 * - Web/extension (Metro web, esbuild SW, Vitest): `@sentry/react`
 * - iOS/Android (Metro native): `@sentry/react-native`
 *
 * The web/extension config drops `replayIntegration` from `integrations` —
 * its loader chain pulls the `https://browser.sentry-cdn.com` literal that
 * Chrome Web Store rejects under MV3 Remote Hosted Code policy. All other
 * sampling/tracing values are kept identical to the native path.
 *
 * @module
 */

import {consoleTransport, getLogger, LogLevel, loggerRegistry} from '@pnyx/logger'
import Constants from 'expo-constants'
import {devLogStreamRequested, sentryDsn} from '../config/env'
import {platformIsWeb} from '../platform/detect'
import {createLocalStreamTransport, resolveLocalStreamEndpoint} from './local-stream-transport'
import {type ScrubbableBreadcrumb, type ScrubbableEvent, scrubBreadcrumb, scrubSentryEvent} from './scrub-sentry'
import {createSentryTransport} from './sentry'
import {getSentryEnvironment} from './sentry-environment'
import * as Sentry from './sentry-sdk'

declare const __DEV__: boolean

const SENTRY_DSN = sentryDsn()
const SENTRY_ENVIRONMENT = getSentryEnvironment({isDev: __DEV__, appEnv: Constants.expoConfig?.extra?.appEnv})

type SentryNavigationIntegration = ReturnType<typeof Sentry.reactNavigationIntegration>

export const sentryNavigationIntegration: SentryNavigationIntegration | null =
  SENTRY_DSN && !platformIsWeb ? Sentry.reactNavigationIntegration({enableTimeToInitialDisplay: true}) : null

// Non-prod (development, dev, preview) → Debug. Production → Info.
// Unknown env is treated as prod-like to stay conservative when env
// detection breaks on a misconfigured build. Exported so the runtime
// devTools toggle in app/_layout can restore the env default when the
// override is turned off.
const isProdlikeEnv = SENTRY_ENVIRONMENT === 'production' || SENTRY_ENVIRONMENT === undefined
export const envDefaultLogLevel = isProdlikeEnv ? LogLevel.Info : LogLevel.Debug

// trailMaxSize is fixed at creation time, so we size it for the
// largest-trail case — devTools flipped on in prod — even when starting
// at Info level. The memory cost is bounded (~10k small entries) and the
// alternative is recreating the logger when devTools toggles, which would
// break every cached reference.
//
// Registry-backed: package loggers (portfolio, transfer, migrations,
// hardware-storage, …) obtain their own named instance via `getLogger`
// and share the registry's transports — adding a transport below via
// `loggerRegistry.addTransport` reaches every named logger at once.
export const logger = getLogger('app', {level: envDefaultLogLevel, trailMaxSize: 10_000})
loggerRegistry.setLevel(envDefaultLogLevel)

// Console transport runs in every build — the registry level already gates
// volume (prod = Info). Without it a production console capture only shows
// modules that bypass the logger, leaving incidents untriageable from a
// user-pasted console.
loggerRegistry.addTransport(consoleTransport)

if (__DEV__) {
  // Local log-streaming MCP server is opt-in: set
  // EXPO_PUBLIC_DEV_LOG_STREAM=1 in your env when the server is running.
  // Default is off so an unconfigured dev terminal isn't spammed with
  // ERR_CONNECTION_REFUSED retries against a missing localhost:9876.
  if (devLogStreamRequested()) {
    // RN: derive the dev-machine LAN IP from Expo's `hostUri` (the same IP
    // Metro is serving the bundle from). Web/extension uses `localhost`.
    const endpoint = resolveLocalStreamEndpoint(Constants.expoConfig?.hostUri)
    if (endpoint !== null) {
      const streamTransport = createLocalStreamTransport({endpoint, source: 'app'})
      loggerRegistry.addTransport(streamTransport)
      // Visible in 3 places: Metro console, in-app DevLogsOverlay, and the
      // MCP buffer itself once the first batch flushes. Three-way absence
      // tells you which leg is broken (bundle / transport / network).
      logger.info('[logger] log-stream transport registered', {origin: 'logger', endpoint})
    } else {
      logger.warn(
        '[logger] log-stream env=1 but no endpoint resolved (hostUri parse / EXPO_PUBLIC_DEV_LOG_STREAM_HOST missing)',
        {origin: 'logger'},
      )
    }
  }
}

// All four sampled features (tracing, profiling, session replay, on-error
// replay) are gated by environment.
//
// Non-prod (development, dev, preview) → full sampling, so
// regressions and crashes are caught with maximum signal during testing.
// Production → 0 for all of them. Two distinct concerns drive that:
//   - Profiling/tracing add per-frame overhead at 100% sample rate.
//   - Session replays are a privacy risk in a crypto wallet: even with
//     `maskAllText`, touch-event coordinates on the on-screen keyboard
//     can leak typed mnemonic / password content. `replaysOnErrorSampleRate`
//     is the worst foot-gun — validation errors fire DURING mnemonic
//     entry, which would ship a replay of the seed input to Sentry.
//     A deeper hardening pass (per-screen `<Mask>` wrappers, breadcrumb
//     filters, `sendDefaultPii: false`) is tracked separately.
// Unknown env is treated as prod-like — safer than shipping full
// instrumentation on a misconfigured build with a Sentry DSN set.
const sentrySampleRate = isProdlikeEnv ? 0 : 1.0

if (SENTRY_DSN) {
  if (platformIsWeb) {
    // Web / extension init. Only the synchronous `rewriteFramesIntegration`
    // is added — `replayIntegration` is omitted because its loader chain pulls
    // the `https://browser.sentry-cdn.com` literal that Chrome Web Store rejects
    // under MV3 Remote Hosted Code policy.
    //
    // `BrowserApiErrors` is filtered out of the defaults: it `wrap()`s every
    // `addEventListener`/`setTimeout`/`rAF` callback and stamps the wrapper
    // (`__sentry_original__`) onto the handler, which retains detached expo-image
    // DOM nodes that never get released on unmount — the unbounded extension
    // heap growth in production. Errors thrown in those callbacks are still caught
    // by the `GlobalHandlers` default (window.onerror / unhandledrejection).
    Sentry.init({
      dsn: SENTRY_DSN,
      ...(SENTRY_ENVIRONMENT !== undefined && {environment: SENTRY_ENVIRONMENT}),
      debug: __DEV__,
      // Sentry catches unhandled exceptions, native crashes and auto-collected
      // breadcrumbs on paths that never touch our logger, so its own redaction
      // pass is required rather than optional (Phase 16 item 44). Same policy
      // object as the logger's, so the two cannot drift.
      // The casts are a structural-interop boundary: the SDK's `ErrorEvent` /
      // `Breadcrumb` declare their optional fields without `| undefined`, which
      // `exactOptionalPropertyTypes` treats as distinct from ours. The scrubber
      // only reads and rewrites the fields it names, so the shape is preserved.
      beforeSend: (event) => scrubSentryEvent(event as unknown as ScrubbableEvent) as unknown as typeof event,
      beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb as unknown as ScrubbableBreadcrumb) as unknown as typeof crumb,
      tracesSampleRate: sentrySampleRate,
      replaysSessionSampleRate: sentrySampleRate,
      replaysOnErrorSampleRate: sentrySampleRate,
      integrations: (defaults) => [
        ...defaults.filter((integration) => integration.name !== 'BrowserApiErrors'),
        Sentry.rewriteFramesIntegration(),
      ],
    })
  } else {
    // Native (iOS / Android) init. Keeps Session Replay, navigation
    // tracking, and full performance tracing in non-prod.
    Sentry.init({
      dsn: SENTRY_DSN,
      ...(SENTRY_ENVIRONMENT !== undefined && {environment: SENTRY_ENVIRONMENT}),
      debug: __DEV__,
      // Sentry catches unhandled exceptions, native crashes and auto-collected
      // breadcrumbs on paths that never touch our logger, so its own redaction
      // pass is required rather than optional (Phase 16 item 44). Same policy
      // object as the logger's, so the two cannot drift.
      // The casts are a structural-interop boundary: the SDK's `ErrorEvent` /
      // `Breadcrumb` declare their optional fields without `| undefined`, which
      // `exactOptionalPropertyTypes` treats as distinct from ours. The scrubber
      // only reads and rewrites the fields it names, so the shape is preserved.
      beforeSend: (event) => scrubSentryEvent(event as unknown as ScrubbableEvent) as unknown as typeof event,
      beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb as unknown as ScrubbableBreadcrumb) as unknown as typeof crumb,
      tracesSampleRate: sentrySampleRate,
      // Hermes sampling profiler — re-enabled for non-prod. It was disabled
      // during the Expo 56 bump, which shipped Hermes V1 and SIGABRT'd the
      // profiler; we reverted to Expo 55 (Hermes V0.x), so it's safe again and
      // gives per-function flame graphs on traced (e.g. navigation)
      // transactions. Off in prod-like via sentrySampleRate.
      profilesSampleRate: sentrySampleRate,
      // Session Replay's Compose-tree traversal throws NoSuchMethodError against the
      // androidx.compose.ui version shipped by Expo SDK 56 (LayoutNode.getChildren$ui_release
      // was removed/renamed). The failure fires every frame, masks the surface to white,
      // and leaks until lowmemorykiller kills the process. Disable until @sentry/react-native
      // ships a SDK-56-compatible replay backend.
      integrations: [...(sentryNavigationIntegration ? [sentryNavigationIntegration] : [])],
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      enableAppStartTracking: true,
      enableNativeFramesTracking: true,
      enableStallTracking: true,
    })
  }

  loggerRegistry.addTransport(createSentryTransport(Sentry))
}

export type {LogEntry, LogMetadata} from '@pnyx/logger'
export {LogLevel} from '@pnyx/logger'
