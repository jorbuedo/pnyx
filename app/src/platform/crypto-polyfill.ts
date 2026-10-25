/**
 * Crypto polyfill for React Native.
 *
 * On native platforms (iOS/Android), installs react-native-quick-crypto
 * which provides the full Web Crypto API (including crypto.subtle.digest)
 * via a native Nitro module. This is required by social-login SDKs and other
 * cryptographic libraries that depend on the Web Crypto API.
 *
 * Falls back to expo-crypto for getRandomValues if quick-crypto is
 * unavailable.
 *
 * IMPORTANT: This file must be imported before any crypto operations.
 *
 * @module
 */

import {isNative} from './detect'

if (isNative) {
  // react-native-quick-crypto provides the full Web Crypto API natively
  // (crypto.subtle.digest, crypto.getRandomValues, etc.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {install} = require('react-native-quick-crypto')
  install()
}
