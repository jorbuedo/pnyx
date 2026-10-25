/**
 * The bare OS device-auth gate, with the dev bypass applied in one place.
 *
 * Two surfaces fall back to `authenticateAsync` when the enclave leg cannot run — the cold-start lock
 * screen and `useEnclaveUnlock`, whose vault read resolves no identity seed yet. Both must honour
 * `EXPO_PUBLIC_INSECURE_DEV_VAULT`, or a dev build that was told to skip the keychain still stops at an
 * OS passcode dialog: `authenticateAsync` is a *separate* gate from the keychain, so bypassing one and
 * not the other leaves the flag half-working — which is exactly how it behaved, and it cost two sessions
 * of typing an emulator PIN.
 *
 * ⚠️ The bypass is `__DEV__ && EXPO_PUBLIC_INSECURE_DEV_VAULT=1` ({@link isInsecureDevVaultEnabled}), the
 * same condition the vault itself uses. A release build cannot reach it — `__DEV__` is false and the
 * bundler drops the branch.
 *
 * @module
 */

import {authenticateAsync} from 'expo-local-authentication'

import {logger} from '../../logger'
import {isInsecureDevVaultEnabled} from './insecure-dev-vault'

const ORIGIN = 'device-auth'

/**
 * Ask the OS to authenticate the user. `false` when they decline or no gate is available.
 *
 * Returns `true` immediately under the dev bypass — logged, because a silent pass on a security gate is
 * exactly the thing that must never be invisible, even in dev.
 */
export const deviceAuth = async (): Promise<boolean> => {
  if (isInsecureDevVaultEnabled()) {
    logger.warn('device auth bypassed by EXPO_PUBLIC_INSECURE_DEV_VAULT — dev builds only', {origin: ORIGIN})
    return true
  }
  try {
    return (await authenticateAsync({disableDeviceFallback: false})).success
  } catch (error) {
    logger.warn('device auth unavailable', {origin: ORIGIN, error: String(error)})
    return false
  }
}
