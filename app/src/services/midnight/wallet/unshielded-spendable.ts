/**
 * `confirmed − locked` — what a balance may show and a send may select.
 *
 * Its own module so the live feed can apply the rule without importing `unshielded.ts`, which imports
 * the feed back. Same reason `settle-pending-sends.ts` is separate: two readers of one feed, and a
 * cycle between them is the shape Metro handles worst.
 *
 * @module
 */

import {projectSpendable} from '@pnyx/wallet'
import {Effect} from 'effect'

import {logger} from '../../../logger'
import {loadUnshieldedLocks, unshieldedUtxoId} from './unshielded-pending-store'
import type {UnshieldedUtxo} from './unshielded-utxo-set'

const ORIGIN = 'midnight-unshielded'

/**
 * Apply the in-flight locks to a confirmed set.
 *
 * `projectSpendable` is Cardano's rule, made generic rather than copied: `confirmed − locked + virtual`,
 * with `virtual` empty here because a Midnight builder reports identifiers and not outpoints. Failure
 * returns the **confirmed** set and logs — refusing to select at all would strand a wallet over a
 * bookkeeping read, and the node still rejects a genuine double-spend.
 */
export const spendableUnshielded = (
  groupId: string,
  accountIndex: number,
  confirmed: readonly UnshieldedUtxo[],
): Effect.Effect<readonly UnshieldedUtxo[]> =>
  Effect.gen(function* () {
    const locks = yield* loadUnshieldedLocks(groupId, accountIndex, Math.floor(Date.now() / 1000))
    if (locks.length === 0) return confirmed
    const spendable = projectSpendable<UnshieldedUtxo>(
      confirmed,
      locks.map((lock) => ({consumedUtxoIds: lock.consumedUtxoIds, change: []})),
      unshieldedUtxoId,
    )
    logger.debug('applied in-flight locks to the unshielded set', {
      origin: ORIGIN,
      groupId,
      confirmed: confirmed.length,
      spendable: spendable.length,
    })
    return spendable
  }).pipe(
    Effect.catchTag('UnshieldedLockError', (error) =>
      Effect.sync(() => {
        logger.warn('could not read the unshielded locks; selecting from the confirmed set', {
          origin: ORIGIN,
          groupId,
          error: error.reason,
        })
        return confirmed
      }),
    ),
  )
