/**
 * Which profile this process is running as.
 *
 * Module-level and set exactly once, by the profile gate, **before any
 * profile-scoped provider mounts**. Everything downstream — storage keys,
 * database filenames, the identity vault slot — reads it synchronously, so it
 * cannot be a React value.
 *
 * Switching profiles within a live process is deliberately not supported here:
 * module-scope caches all over the app (the MMKV handle, the installation id,
 * the ceremony cache, the provider registry) would survive a React remount and
 * serve the previous profile's state. The gate reloads the process instead.
 *
 * @module
 */

import {DEFAULT_PROFILE_ID, type ProfileId, profileDbInfix, profileKeyPrefix} from './profile-id'

let active: ProfileId = DEFAULT_PROFILE_ID
let locked = false

/**
 * Set the profile for this process. The gate calls this before rendering its
 * children; later calls are ignored so a stray caller cannot repoint storage
 * out from under mounted providers.
 */
export const setActiveProfile = (id: ProfileId): void => {
  if (locked) return
  active = id
  locked = true
}

export const getActiveProfile = (): ProfileId => active

/**
 * True once a profile has actually been adopted for this process.
 *
 * Distinct from `getActiveProfile() === DEFAULT_PROFILE_ID`, which is also the
 * value before anything has been adopted at all. The gate needs the difference:
 * on a first challenge nothing profile-scoped has mounted yet, so any code may
 * be honoured in place, while a *switch* after one is open needs a process
 * reload to shed module-level state.
 */
export const isProfileAdopted = (): boolean => locked

/** Storage key prefix for the active profile (empty for the default). */
export const activeKeyPrefix = (): string => profileKeyPrefix(active)

/** Database name infix for the active profile (empty for the default). */
export const activeDbInfix = (): string => profileDbInfix(active)

/** Test seam — production never unlocks the profile once the gate has set it. */
export const __resetActiveProfileForTests = (): void => {
  active = DEFAULT_PROFILE_ID
  locked = false
}
