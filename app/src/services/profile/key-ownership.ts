/**
 * Which profile a storage key belongs to — pure.
 *
 * The default profile is unprefixed, which is what makes this feature
 * migration-free but also means "the default profile's keys" cannot be
 * expressed as a prefix match. It is a subtraction: everything that is not
 * another profile's and not device-global.
 *
 * Getting this wrong is not a cosmetic bug. A wipe that treats the device-global
 * keys as the default profile's would take the lock configuration with it; one
 * that treats another profile's prefixed keys as the default's would destroy the
 * decoy while the user is standing in it.
 *
 * @module
 */

import {DEFAULT_PROFILE_ID, type ProfileId, profileKeyPrefix} from './profile-id'

/**
 * Keys that are the same bytes in every profile.
 *
 * Deliberately short. Everything absent from this list is profile-scoped, and
 * that default is the safe direction: a global key wrongly scoped is merely
 * re-set inside the decoy, while a scoped key wrongly made global leaks the real
 * profile into the decoy.
 */
export const DEVICE_GLOBAL_KEYS: readonly string[] = [
  '@pnyx/lock-config',
  '@pnyx/lock-armed',
  '@pnyx/pending-wipe',
  '@pnyx/installation-id',
  '@pnyx/network',
  '@pnyx/remote-config-cache',
  '@pnyx/legal_agreement',
  '@pnyx/theme',
  '@pnyx/locale',
]

/** Prefix marking a key as belonging to some non-default profile. */
export const PROFILE_KEY_NAMESPACE = '@profile/'

export const isDeviceGlobalKey = (key: string): boolean => DEVICE_GLOBAL_KEYS.includes(key)

/**
 * Does `key` hold data for `profile`?
 *
 * Device-global keys belong to no profile and always answer false — they are
 * never destroyed by wiping one.
 */
export const keyBelongsToProfile = (key: string, profile: ProfileId): boolean => {
  if (isDeviceGlobalKey(key)) return false

  if (profile === DEFAULT_PROFILE_ID) {
    // The default profile owns everything that is not explicitly someone else's.
    return !key.startsWith(PROFILE_KEY_NAMESPACE)
  }

  return key.startsWith(profileKeyPrefix(profile))
}

/** The subset of `keys` that a wipe of `profile` should remove. */
export const keysToWipe = (keys: readonly string[], profile: ProfileId): readonly string[] =>
  keys.filter((key) => keyBelongsToProfile(key, profile))
