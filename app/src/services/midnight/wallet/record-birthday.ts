/**
 * Stamp a wallet's shielded birthday — the block height its history starts at (plan item 61(a)).
 *
 * ⚠️ **This is only correct at creation, and cannot be deferred.** A wallet created now and first
 * synced tomorrow would record tomorrow's tip and silently skip a day of chain, because nothing
 * rescans a range the cursor has passed. Same argument as the Midnight receive addresses derived in
 * `wallet-service`: the moment is only available once.
 *
 * **Every network, not just the selected one**, for the same reason — a network switch later has no
 * way to recover where the seed started on the network it switched to.
 *
 * Best-effort throughout: a wallet must never fail to be created because an indexer was down. What a
 * failure costs is precise and is logged as such — that network falls back to scanning a window below
 * the tip, so a coin older than the window is invisible until the values are supplied by hand.
 *
 * @module
 */

import {Effect} from 'effect'

import {NETWORKS} from '../../../config/networks'
import {logger} from '../../../logger'
import {recordRecoveryBirthday} from '../../passkey-recovery'
import {fetchTipHeight} from './shielded-sync'
import {saveShieldedBirthday} from './state-store'
import type {ShieldedBirthday} from './sync-window'

const ORIGIN = 'shielded-birthday'

/** The app's network names are the Midnight ones, so this list needs no mapping. */
const MIDNIGHT_NETWORKS: readonly string[] = NETWORKS

/**
 * Record today's tip as this group's birthday on every Midnight network, locally and in the passkey
 * recovery blob.
 *
 * Returns the networks actually stamped, so a caller can log a real count instead of "done".
 */
export const recordShieldedBirthdays = (groupId: string): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const recorded: string[] = []
    for (const network of MIDNIGHT_NETWORKS) {
      const tip = yield* fetchTipHeight(network).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            // ⚠️ Named per network, and levelled by whether anything is wrong. A build that serves no
            // indexer for a network has nothing to record and never will — that is a state, not a
            // fault. A tip read that *failed* is the one worth acting on, and the consequence is per
            // network: only that one scans shallow.
            const say = error.cause === 'not-configured' ? logger.debug : logger.warn
            say('no birthday recorded: the tip could not be read', {
              origin: ORIGIN,
              groupId,
              network,
              cause: error.cause,
              error: error.reason,
            })
            return null
          }),
        ),
      )
      if (tip === null) continue

      yield* saveShieldedBirthday(groupId, network, {height: tip, origin: 'created'})
      // The durable copy. A device with no passkey enrollment has nowhere to put it, which is not a
      // failure — `recordRecoveryBirthday` says so by answering false, and logs which case it was.
      yield* Effect.promise(() => recordRecoveryBirthday(network, tip))
      recorded.push(network)
    }
    if (recorded.length === 0) {
      logger.warn('no shielded birthday recorded on any network', {origin: ORIGIN, groupId})
    } else {
      logger.info('shielded birthdays recorded', {origin: ORIGIN, groupId, networks: recorded.join(',')})
    }
    return recorded
  })

/**
 * Adopt the birthdays a passkey restore handed back, under the **new** group id.
 *
 * The group id does not survive a device loss — a restore generates a fresh one — so the blob keys
 * these by network alone and they are re-keyed here.
 *
 * `origin: 'recovered'` rather than `'created'`: the number is the same and so is the guarantee, but
 * the two answer different questions in a log, and the one worth telling apart later is whether this
 * device ever saw the seed born.
 */
export const adoptRecoveredBirthdays = (
  groupId: string,
  birthdays: Readonly<Record<string, number>> | undefined,
): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    if (birthdays === undefined || Object.keys(birthdays).length === 0) {
      // ⚠️ Not silent. A restore with no birthdays is a wallet that will scan from the tip and show a
      // balance of nothing for coins it genuinely holds, and this line is the only warning of it.
      logger.warn('restored wallet carries no shielded birthday: its first sync starts below the tip', {
        origin: ORIGIN,
        groupId,
      })
      return []
    }
    const adopted: string[] = []
    for (const [network, height] of Object.entries(birthdays)) {
      const birthday: ShieldedBirthday = {height, origin: 'recovered'}
      yield* saveShieldedBirthday(groupId, network, birthday)
      adopted.push(network)
    }
    logger.info('shielded birthdays adopted from the recovery blob', {
      origin: ORIGIN,
      groupId,
      networks: adopted.join(','),
    })
    return adopted
  })
