/**
 * Profile identity — the namespace a session runs in.
 *
 * A profile owns a storage partition, a set of databases, and an identity
 * seed. The app opens exactly one at a time, chosen by the PIN gate before any
 * profile-scoped provider mounts.
 *
 * The default profile is deliberately **unprefixed and unsuffixed** everywhere:
 * its storage keys, database filenames and identity vault slot are byte-identical
 * to what an install that predates profiles already wrote. That is what makes
 * this whole feature migration-free — an existing user becomes the default
 * profile by definition, with nothing to move.
 *
 * @module
 */

/** A profile namespace id. `default` is the real profile on every install. */
export type ProfileId = string & {readonly __brand: 'ProfileId'}

/** The profile every install starts with, and the only one that is unprefixed. */
export const DEFAULT_PROFILE_ID = 'default' as ProfileId

/** The decoy namespace. A fixed id: there is at most one decoy. */
export const DECOY_PROFILE_ID = 'decoy' as ProfileId

/** Every profile the app can open. */
export const ALL_PROFILE_IDS: readonly ProfileId[] = [DEFAULT_PROFILE_ID, DECOY_PROFILE_ID]

/**
 * Storage key prefix for a profile. Empty for the default profile so its keys
 * keep their historical names.
 */
export const profileKeyPrefix = (id: ProfileId): string => (id === DEFAULT_PROFILE_ID ? '' : `@profile/${id}/`)

/**
 * Filename / instance-name infix for a profile's databases. Empty for the
 * default profile so `pnyx-mainnet.db` stays `pnyx-mainnet.db`.
 */
export const profileDbInfix = (id: ProfileId): string => (id === DEFAULT_PROFILE_ID ? '' : `${id}-`)

/** Parse a stored profile id, falling back to the default on anything unknown. */
export const parseProfileId = (raw: string | null | undefined): ProfileId => {
  if (raw === DECOY_PROFILE_ID) return DECOY_PROFILE_ID
  return DEFAULT_PROFILE_ID
}
