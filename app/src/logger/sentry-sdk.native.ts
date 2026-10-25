/**
 * Native-target override for the Sentry SDK shim.
 *
 * Metro auto-picks this file over `sentry-sdk.ts` on iOS/Android. See the
 * base file for context on why web/extension must NOT see `@sentry/react-native`.
 *
 * @module
 */

export * from '@sentry/react-native'
