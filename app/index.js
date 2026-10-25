/**
 * Custom entry point for polyfills and Unistyles configuration.
 *
 * This file sets up global Buffer and process before expo-router loads,
 * which is required by libraries like readable-stream (which accesses
 * process.version and process.browser).
 *
 * CRITICAL ORDER:
 * 1. Buffer + process polyfills (required by Node-flavoured libraries)
 * 2. URL polyfill (required by partner SDKs)
 * 3. Crypto polyfill (required for React Native crypto operations)
 * 4. Firebase background message handler (must be registered before app mounts)
 * 5. Chains-core global options (indexer URL for chain packages)
 * 6. Unistyles configuration (MUST be before Expo Router loads routes)
 * 7. Dev fetch proxy (web only)
 * 8. Midnight ledger WASM bootstrap (web only)
 * 9. Expo Router entry (loads route files that import styled components)
 *
 * IMPORTANT: Uses require() instead of import to prevent ES module hoisting.
 * Metro/React Native injects a minimal process object ({env: {NODE_ENV}})
 * that lacks `version` and `browser`, so we must merge the full polyfill
 * into the existing object rather than conditionally replacing it.
 */

const {Buffer} = require('buffer')

// buffer@6.0.3 overrides Buffer.prototype.slice to re-apply Buffer.prototype,
// but inherits subarray from Uint8Array — which returns a plain Uint8Array and
// makes .toString('hex') fall back to comma-joined decimals. Some libraries'
// xpub decoders use subarray, which silently broke chainCode decoding on React
// Native. Node's native Buffer preserves the Buffer prototype through subarray;
// mirror that here.
if (Buffer.prototype.subarray === Uint8Array.prototype.subarray) {
  Buffer.prototype.subarray = function subarray(start, end) {
    const newBuf = Uint8Array.prototype.subarray.call(this, start, end)
    Object.setPrototypeOf(newBuf, Buffer.prototype)
    return newBuf
  }
}

const processPolyfill = require('process')

// Merge polyfill into existing process (Metro already sets process.env.NODE_ENV)
if (typeof global !== 'undefined') {
  global.Buffer = Buffer
  global.process = Object.assign({}, processPolyfill, global.process)
}
if (typeof globalThis !== 'undefined') {
  globalThis.Buffer = Buffer
  globalThis.process = Object.assign({}, processPolyfill, globalThis.process)
}

// 2. URL polyfill (patches global URL/URLSearchParams — required by partner SDKs)
require('react-native-url-polyfill/auto')

// Array.prototype.toSorted / toReversed (ES2023): older Hermes builds shipped
// with Expo SDK 54 don't expose these. The transaction-witness builder uses
// both; without the polyfill the NIGHT escrow redeem (and any other Plutus tx
// path) throws `hashes?.toSorted is not a function`.
if (!Array.prototype.toSorted) {
  Object.defineProperty(Array.prototype, 'toSorted', {
    value: function toSorted(compareFn) {
      return [...this].sort(compareFn)
    },
    writable: true,
    configurable: true,
  })
}
if (!Array.prototype.toReversed) {
  Object.defineProperty(Array.prototype, 'toReversed', {
    value: function toReversed() {
      return [...this].reverse()
    },
    writable: true,
    configurable: true,
  })
}

// Intl polyfills — Hermes exposes only Intl.Collator, Intl.DateTimeFormat,
// Intl.NumberFormat and Intl.getCanonicalLocales. PluralRules is missing, which
// intl-messageformat (the i18n engine) needs for every `{count, plural, …}`
// string; without it each one throws and renders the raw ICU template.
// RelativeTimeFormat is missing too, and there the constructor call itself
// throws — so any screen formatting a relative time crashes on device while
// working on web. PluralRules' construction path also needs
// Intl.getCanonicalLocales and Intl.Locale, so those prerequisites must be
// polyfilled first, in order (per @formatjs's documented React Native setup).
// Each shouldPolyfill() is a no-op on web/V8 where the primitive is already
// native.
if (require('@formatjs/intl-getcanonicallocales/should-polyfill.js').shouldPolyfill()) {
  require('@formatjs/intl-getcanonicallocales/polyfill-force.js')
}
if (require('@formatjs/intl-locale/should-polyfill.js').shouldPolyfill()) {
  require('@formatjs/intl-locale/polyfill-force.js')
}
// Locale-data requires MUST be static string literals — Metro/esbuild can't
// resolve a templated/looped require() path, so the data would be missing from
// the bundle and the polyfill would crash at startup.
if (require('@formatjs/intl-pluralrules/should-polyfill.js').shouldPolyfill()) {
  require('@formatjs/intl-pluralrules/polyfill-force.js')
  require('@formatjs/intl-pluralrules/locale-data/en.js')
  require('@formatjs/intl-pluralrules/locale-data/de.js')
  require('@formatjs/intl-pluralrules/locale-data/es.js')
  require('@formatjs/intl-pluralrules/locale-data/fr.js')
  require('@formatjs/intl-pluralrules/locale-data/id.js')
  require('@formatjs/intl-pluralrules/locale-data/ja.js')
  require('@formatjs/intl-pluralrules/locale-data/ko.js')
  require('@formatjs/intl-pluralrules/locale-data/pt.js')
  require('@formatjs/intl-pluralrules/locale-data/ru.js')
  require('@formatjs/intl-pluralrules/locale-data/vi.js')
  require('@formatjs/intl-pluralrules/locale-data/zh.js')
}
// RelativeTimeFormat needs PluralRules at format time, so it loads last.
// zh-Hant is carried in addition to zh: zh-TW's wording differs ("昨天" vs the
// Hant forms) and only an exact data entry gives the Traditional strings.
if (require('@formatjs/intl-relativetimeformat/should-polyfill.js').shouldPolyfill()) {
  require('@formatjs/intl-relativetimeformat/polyfill-force.js')
  require('@formatjs/intl-relativetimeformat/locale-data/en.js')
  require('@formatjs/intl-relativetimeformat/locale-data/de.js')
  require('@formatjs/intl-relativetimeformat/locale-data/es.js')
  require('@formatjs/intl-relativetimeformat/locale-data/fr.js')
  require('@formatjs/intl-relativetimeformat/locale-data/id.js')
  require('@formatjs/intl-relativetimeformat/locale-data/ja.js')
  require('@formatjs/intl-relativetimeformat/locale-data/ko.js')
  require('@formatjs/intl-relativetimeformat/locale-data/pt.js')
  require('@formatjs/intl-relativetimeformat/locale-data/ru.js')
  require('@formatjs/intl-relativetimeformat/locale-data/vi.js')
  require('@formatjs/intl-relativetimeformat/locale-data/zh.js')
  require('@formatjs/intl-relativetimeformat/locale-data/zh-Hant.js')
}

// 3. Crypto polyfill
require('./src/platform/crypto-polyfill')

// 4. Register Firebase background message handler BEFORE app mounts.
//    Runs headlessly (Android) when a FCM message arrives while the app is
//    backgrounded or killed. Stores the event so it appears in the inbox.
//    iOS note: this does NOT fire for notification messages on iOS — APNs
//    handles display; those events enter the list when the user taps them.
//    Skipped on web — FCM is not supported on web.
const {Platform} = require('react-native')
if (Platform.OS !== 'web') {
  const {getMessaging, setBackgroundMessageHandler} = require('@react-native-firebase/messaging')
  setBackgroundMessageHandler(getMessaging(), async (remoteMessage) => {
    const {pushNotificationManager} = require('./src/services/notification-manager')
    const {deriveSweptTrigger} = require('./src/platform/notification-sweep-pure')
    const {idFromString} = require('./src/services/notification-types')

    const data = remoteMessage.data ?? {}
    const {isLocallyReconciled} = require('./src/services/notification-types')
    // The OS still shows the banner; only the in-app row is skipped. For a DM the app writes that
    // row itself, naming the sender the push is not allowed to carry — see LOCALLY_RECONCILED_KINDS.
    if (isLocallyReconciled(data)) return
    const title = remoteMessage.notification?.title ?? ''
    const body = remoteMessage.notification?.body ?? ''
    const date = remoteMessage.sentTime ? new Date(remoteMessage.sentTime).toISOString() : new Date().toISOString()

    await pushNotificationManager.events.push({
      // Hash via the shared djb2 helper so the background row's id matches
      // every other entry point (foreground onMessage / opened-app tap /
      // cold-start / notifee tap / iOS sweep) and de-duplication works.
      id: idFromString(remoteMessage.messageId),
      date,
      isRead: false,
      title,
      body,
      data,
      // Was hard-coded `'push'` — every background-delivered card notif
      // landed under Trigger.Push regardless of payload. Route through the
      // existing classifier so the row's trigger matches the sweep + tap
      // paths (and the per-trigger notify gate fires correctly).
      trigger: deriveSweptTrigger(data, title, body),
    })
  })
}

// 5. Configure Unistyles BEFORE Expo Router loads routes
const {configureUnistyles} = require('./src/theme')

configureUnistyles('pnyxDark')

// 6. Patch fetch on web dev to proxy CORS-blocked API requests
if (__DEV__) {
  require('./src/platform/dev-fetch-proxy')
}

// 7. Midnight ledger WASM bootstrap (web only — registers the async
//    instantiate hook the @pnyx/wallet curve backend awaits; no-op on native)
require('./src/platform/midnight-ledger')

// 8. Now safe to load Expo Router (which imports route files)
require('expo-router/entry')
