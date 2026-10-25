/**
 * JS surface for the native Block Store module (`BlockStoreNative`, Android).
 *
 * Google Block Store is small (per-entry ≤ a few KB), cross-device,
 * end-to-end-encrypted key/value storage backed up to the user's Google
 * account. Pnyx uses it to sync the passkey-wrapped recovery blob so a new
 * device can fetch it — the ciphertext is useless without the passkey's PRF
 * output, so cloud custody of the blob is safe.
 *
 * Android-only: the module is absent on iOS (see `expo-module.config.json`),
 * where `requireOptionalNativeModule` returns null and `isAvailable()` is
 * false. iOS syncs the same blob through a `cloudSync` iCloud-Keychain item
 * instead (handled one layer up, in the app's synced-recovery-store).
 *
 * @module
 */

import {requireOptionalNativeModule} from 'expo-modules-core'

type BlockStoreNativeSpec = {
  isAvailable(): boolean
  setItem(key: string, value: string): Promise<void>
  getItem(key: string): Promise<string | null>
  removeItem(key: string): Promise<void>
}

const native = requireOptionalNativeModule<BlockStoreNativeSpec>('BlockStoreNative')

/** Whether Block Store (Play Services) is present on this device. Never throws. */
export const isAvailable = (): boolean => {
  try {
    return native?.isAvailable() ?? false
  } catch {
    return false
  }
}

/** Store `value` under `key`, opted into cross-device cloud backup. */
export const setItem = (key: string, value: string): Promise<void> => {
  if (native === null) throw new Error('BlockStoreNative is unavailable on this platform')
  return native.setItem(key, value)
}

/** Read the value for `key`, or `null` when absent. */
export const getItem = (key: string): Promise<string | null> => {
  if (native === null) throw new Error('BlockStoreNative is unavailable on this platform')
  return native.getItem(key)
}

/** Delete the entry for `key`. */
export const removeItem = (key: string): Promise<void> => {
  if (native === null) throw new Error('BlockStoreNative is unavailable on this platform')
  return native.removeItem(key)
}
