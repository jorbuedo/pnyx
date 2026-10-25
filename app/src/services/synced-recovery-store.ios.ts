/**
 * iOS synced store for the passkey recovery blob — a `cloudSync` keychain item.
 *
 * `cloudSync: true` sets `kSecAttrSynchronizable`, so the item replicates
 * through iCloud Keychain to the user's other devices — the same custody as
 * the recovery passkey. The query on read/remove must also set `cloudSync` for
 * `kSecAttrSynchronizable` to match. Synchronizable items can't use a
 * `*_THIS_DEVICE_ONLY` class, so accessibility is `AFTER_FIRST_UNLOCK`.
 *
 * @module
 */

import * as Keychain from 'react-native-keychain'

/** Fixed account name; the caller's key maps to the keychain `service`. */
const ACCOUNT = 'pnyx-recovery'

export const isAvailable = (): boolean => true

export const setItem = async (key: string, value: string): Promise<void> => {
  await Keychain.setGenericPassword(ACCOUNT, value, {
    service: key,
    cloudSync: true,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK,
  })
}

export const getItem = async (key: string): Promise<string | null> => {
  const result = await Keychain.getGenericPassword({service: key, cloudSync: true})
  return result === false ? null : result.password
}

export const removeItem = async (key: string): Promise<void> => {
  await Keychain.resetGenericPassword({service: key, cloudSync: true})
}
