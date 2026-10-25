/**
 * Platform detection — which OS / runtime the app is executing on.
 *
 * Universal and always live. Kept separate from the dormant extension client
 * (`./extension/*`) so the ~6 modules that only need "am I web / native?" don't
 * depend on the browser-extension surface. See `docs/EXTENSION.md`.
 *
 * @module
 */

import {Platform} from 'react-native'

export const platformIsWeb = Platform.OS === 'web'

export const platformIsIOS = Platform.OS === 'ios'

export const platformIsAndroid = Platform.OS === 'android'

/**
 * Running on a native platform (iOS or Android).
 */
export const isNative = platformIsIOS || platformIsAndroid
