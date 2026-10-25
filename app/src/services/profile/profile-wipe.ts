/**
 * Destroy one profile, from inside another.
 *
 * Runs when the wipe code is entered: the app opens the decoy and this runs
 * behind it, so what a coercer sees is an ordinary unlock into an ordinary
 * wallet. Nothing here may block the UI or surface an error to the user.
 *
 * **The PIN survives.** The wipe destroys the identity, the wallets and their
 * data — not the lock configuration. So the real PIN still works afterwards and
 * opens an empty main profile the user can restore into from their recovery
 * phrase. An earlier version dropped the real verifier so the code would visibly
 * fail; that was worse on both sides. A code that fails in front of a coercer
 * invites "try again" and reads as stalling, whereas an empty wallet reads as
 * having had nothing. And it left the real namespace unreachable by any code, so
 * a user who triggered the wipe themselves could never get back into their own
 * profile.
 *
 * Order is by value, not convenience. Seeds go first because they are the only
 * irreversible part and the process may be killed at any moment — a wipe
 * interrupted after step 1 has already destroyed the keys, which is the outcome
 * that matters. Bulk data follows.
 *
 * @module
 */

import {createPlatformStorage, createPrefixedStorage} from '@pnyx/storage'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {isNative} from '../../platform'
import {deviceStorage} from '../../platform/storage'
import {createEnclaveMnemonicVault} from '../credential-vault'
import {identityVaultIdFor} from '../identity-wallet'
import {stopAllUnshieldedFeeds} from '../midnight/wallet/unshielded-live'
import {removePasskeyRecovery} from '../passkey-recovery'
import {keysToWipe} from './key-ownership'
import {DEFAULT_PROFILE_ID, type ProfileId, profileDbInfix, profileKeyPrefix} from './profile-id'

/** Set while a wipe is in flight so an interrupted one resumes on next launch. */
const PENDING_WIPE_KEY = '@pnyx/pending-wipe'

const WALLET_GROUPS_KEY = '@pnyx/wallet/groups'

const NETWORKS = ['mainnet', 'preprod', 'preview'] as const

/** Every database family `wallet-service.ts` opens, in the same naming scheme. */
const DB_FAMILIES = ['', 'tx-', 'utxo-', 'assets-', 'token-metadata-', 'token-prices-', 'price-point-', 'address-']

const groupIdsIn = async (profile: ProfileId): Promise<readonly string[]> => {
  try {
    const storage = createPrefixedStorage(createPlatformStorage(), profileKeyPrefix(profile))
    const raw = await Effect.runPromise(storage.get(WALLET_GROUPS_KEY))
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((g): unknown => (typeof g === 'object' && g !== null ? (g as {id?: unknown}).id : undefined))
      .filter((id): id is string => typeof id === 'string')
  } catch (error) {
    logger.warn('[ProfileWipe] could not read group ids', {origin: 'ProfileWipe', error: String(error)})
    return []
  }
}

const deleteDatabases = async (profile: ProfileId): Promise<void> => {
  if (!isNative) return
  let SQLite: {deleteDatabaseAsync: (name: string) => Promise<void>}
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SQLite = require('expo-sqlite') as {deleteDatabaseAsync: (name: string) => Promise<void>}
  } catch (e: unknown) {
    // Returning here skips EVERY database this profile owns, and the wipe still reports success.
    logger.warn('[ProfileWipe] expo-sqlite unavailable; no profile database was deleted', {
      origin: 'ProfileWipe',
      profile,
      error: String(e),
    })
    return
  }

  const infix = profileDbInfix(profile)
  for (const family of DB_FAMILIES) {
    for (const network of NETWORKS) {
      const name = `pnyx-${family}${infix}${network}.db`
      try {
        await SQLite.deleteDatabaseAsync(name)
      } catch (e: unknown) {
        // Ordinarily "no such file" — a database never opened for this profile/network. A real
        // delete failure looks identical here and leaves profile data behind after a wipe.
        logger.debug('[ProfileWipe] database not deleted; it may never have existed', {
          origin: 'ProfileWipe',
          database: name,
          error: String(e),
        })
      }
    }
  }
}

/**
 * Erase `profile` completely.
 *
 * Best-effort throughout: every step is independently guarded so one failure
 * cannot abandon the rest. A wipe that gets through the seeds and stalls on
 * bulk data has still done the part that counts, and the pending marker brings
 * it back on the next launch.
 */
export const wipeProfile = async (profile: ProfileId): Promise<void> => {
  logger.info('[ProfileWipe] starting', {origin: 'ProfileWipe', profile})
  await deviceStorage.set(PENDING_WIPE_KEY, profile).catch((e) => {
    // Without the marker an interrupted wipe is not resumed on the next launch.
    logger.warn('[ProfileWipe] failed to set the pending marker', {
      origin: 'ProfileWipe',
      profile,
      error: String(e),
    })
  })

  const vault = createEnclaveMnemonicVault()

  // 1. The identity seed for that profile — first, because it is the one thing
  //    that cannot be recreated and the process may die at any point.
  try {
    await Effect.runPromise(vault.delete(identityVaultIdFor(profile)))
  } catch (error) {
    logger.warn('[ProfileWipe] identity seed delete failed', {origin: 'ProfileWipe', error: String(error)})
  }

  // 2. Every wallet group's mnemonic.
  for (const groupId of await groupIdsIn(profile)) {
    try {
      await Effect.runPromise(vault.delete(groupId))
    } catch (e: unknown) {
      // Ordinarily "no entry" — hardware and read-only groups never had one. A real failure
      // leaves a mnemonic in the enclave after the profile that owned it is gone.
      logger.warn('[ProfileWipe] enclave entry not deleted; it may still hold a mnemonic', {
        origin: 'ProfileWipe',
        groupId,
        error: String(e),
      })
    }
  }

  // 3. The cloud recovery blob. Deleted deliberately, even though the user's own
  //    recovery path survives: the blob is unwrapped by a passkey held on *this*
  //    phone, so leaving it would let whoever keeps the device restore the very
  //    identity the wipe just destroyed. The written recovery phrase is the
  //    recovery path, not this. This is a local keychain delete whose deletion
  //    replicates when network returns — an adversary who keeps the device
  //    offline and restores elsewhere first still wins that race.
  if (profile === DEFAULT_PROFILE_ID) {
    await removePasskeyRecovery().catch((error: unknown) => {
      logger.warn('[ProfileWipe] recovery blob delete failed', {origin: 'ProfileWipe', error: String(error)})
    })
  }

  // 4. Bulk data.
  await deleteDatabases(profile)

  // ⚠️ **Before the keys go.** The live unshielded feeds hold a parsed UTxO set and a history in
  // memory and write it back as the chain moves, so a feed left running would re-materialise money
  // data this wipe had just deleted. Nothing else in the app holds these bytes, which is exactly why
  // deleting the raw keys used to be sufficient.
  await Effect.runPromise(stopAllUnshieldedFeeds())

  // Explicit key selection, never `clear()`. The default profile is unprefixed,
  // so a blanket clear would take the decoy's keys and the lock config with it.
  try {
    const raw = createPlatformStorage()
    const all = await Effect.runPromise(raw.keys())
    const doomed = keysToWipe(all, profile)
    if (doomed.length > 0) await Effect.runPromise(raw.multiRemove(doomed))
  } catch (error) {
    logger.warn('[ProfileWipe] storage clear failed', {origin: 'ProfileWipe', error: String(error)})
  }

  await deviceStorage.remove(PENDING_WIPE_KEY).catch((e) => {
    logger.warn('[ProfileWipe] failed to clear the pending marker; the next launch re-wipes', {
      origin: 'ProfileWipe',
      profile,
      error: String(e),
    })
  })
  logger.info('[ProfileWipe] complete', {origin: 'ProfileWipe', profile})
}

/**
 * Finish a wipe that a kill interrupted. Called once at boot, above the gate.
 *
 * The marker itself is device-global, so `keysToWipe` never selects it and the
 * wipe cannot delete its own resume record mid-run. Re-running is harmless:
 * every step is idempotent.
 */
export const resumePendingWipe = async (): Promise<void> => {
  const pending = deviceStorage.getSync(PENDING_WIPE_KEY)
  if (pending === null) return
  logger.info('[ProfileWipe] resuming interrupted wipe', {origin: 'ProfileWipe', profile: pending})
  await wipeProfile(pending as ProfileId)
}
