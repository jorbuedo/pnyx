/**
 * Android synced store for the passkey recovery blob — Google Block Store.
 *
 * Block Store (`@pnyx/blockstore-native`) replicates small entries to the
 * user's Google account, end-to-end encrypted and restored on a new device at
 * sign-in — the same custody as the recovery passkey (Google Password Manager).
 *
 * @module
 */

import {
  getItem as bsGetItem,
  isAvailable as bsIsAvailable,
  removeItem as bsRemoveItem,
  setItem as bsSetItem,
} from '@pnyx/blockstore-native'

export const isAvailable = (): boolean => bsIsAvailable()

export const setItem = (key: string, value: string): Promise<void> => bsSetItem(key, value)

export const getItem = (key: string): Promise<string | null> => bsGetItem(key)

export const removeItem = (key: string): Promise<void> => bsRemoveItem(key)
