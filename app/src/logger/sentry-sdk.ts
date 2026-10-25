/**
 * Platform-bifurcated Sentry SDK shim.
 *
 * - This file (base / web / Node-tests) re-exports `@sentry/react`.
 * - `sentry-sdk.native.ts` (Metro picks on iOS/Android) re-exports `@sentry/react-native`.
 *
 * Web/extension builds must not pull `@sentry/react-native`, because its
 * transitive dependency on `@sentry/browser` drags in `lazyLoadIntegration`
 * and the `https://browser.sentry-cdn.com` literal that the Chrome Web Store
 * MV3 RHC scanner rejects.
 *
 * Stubs are provided for native-only members (`wrap`, `reactNavigationIntegration`,
 * `mobileReplayIntegration`) so call sites can import them unconditionally.
 *
 * @module
 */

import * as SentryReact from '@sentry/react'

type Integration = {
  name: string
  setupOnce?: () => void
}

type NativeOnlyInitOptions = {
  enableAppStartTracking?: boolean
  enableNativeFramesTracking?: boolean
  enableStallTracking?: boolean
  profilesSampleRate?: number
}

type WebInitOptions = NonNullable<Parameters<typeof SentryReact.init>[0]>

export type InitOptions = WebInitOptions & NativeOnlyInitOptions

type ReactNavigationIntegrationShim = Integration & {
  registerNavigationContainer: (ref: unknown) => void
}

const init = (options?: InitOptions): void => {
  SentryReact.init(options as WebInitOptions)
}

export * from '@sentry/react'
export {init}

export const wrap = <T>(component: T): T => component

export const reactNavigationIntegration = (..._args: unknown[]): ReactNavigationIntegrationShim | null => null

export const mobileReplayIntegration = (..._args: unknown[]): Integration => ({
  name: 'mobile-replay-noop',
  setupOnce: () => {},
})
