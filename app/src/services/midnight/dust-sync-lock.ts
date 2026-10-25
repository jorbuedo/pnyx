/**
 * One DUST sync at a time per wallet.
 *
 * ⚠️ **The scheduler already cannot overlap itself** — it runs one fiber per `(groupId, chainId)` and
 * awaits the sync before sleeping, so ticks are serial by construction. The overlap this guards is
 * *across callers*: a manual refresh, the DUST probe and a scheduled tick are three separate paths into
 * `syncDust`, and nothing stopped two of them running at once. A DUST rebuild is a 70–90 s native
 * replay that walks both Merkle trees, so two at once on a phone is real contention for no benefit —
 * and the second would be rebuilding from the same chain data the first is already reading.
 *
 * ### Waiting, not skipping
 *
 * A second caller **waits** for the first and then runs its own sync. It does not skip, and it does not
 * receive the first one's result:
 *
 * - Skipping would make the refresh button do nothing while a background tick happened to be running,
 *   which is a UI that lies about what it did.
 * - Sharing the result would be wrong, because callers pass different arguments — `atUnixSecs`, and the
 *   repair list a caller loaded before it started. Handing one caller another's result would silently
 *   answer a different question.
 *
 * So the second run is redundant work in the rare case, and correct in every case. Serialising is the
 * point; deduplicating is not.
 *
 * @module
 */

import {Effect} from 'effect'

import {logger} from '../../logger'

const ORIGIN = 'midnight-dust-sync-lock'

/** One permit per wallet. Created on first use and kept — a semaphore per account is a few bytes. */
const permits = new Map<string, Effect.Semaphore>()

const keyOf = (groupId: string, accountIndex: number): string => `${groupId}:${accountIndex}`

/** Long enough that a real queue is reported and an uncontended acquire is not. */
const WAIT_LOG_MS = 250

const permitFor = (key: string): Effect.Effect<Effect.Semaphore> =>
  Effect.gen(function* () {
    const existing = permits.get(key)
    if (existing !== undefined) return existing
    const made = yield* Effect.makeSemaphore(1)
    permits.set(key, made)
    return made
  })

/**
 * Run `sync` with this wallet's DUST permit held.
 *
 * Keyed per `(groupId, accountIndex)` rather than globally: two different wallets' rebuilds do not
 * contend for the same state, and serialising them would make a multi-wallet sweep needlessly slow.
 *
 * Composed with `flatMap` rather than `Effect.gen`, so `sync`'s own error and context types survive
 * instead of being widened to `unknown`.
 */
export const withDustSyncPermit = <A, E, R>(
  groupId: string,
  accountIndex: number,
  sync: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(permitFor(keyOf(groupId, accountIndex)), (permit) => {
    const asked = Date.now()
    return permit.withPermits(1)(
      // Suspended so the elapsed time is measured when the permit is granted, not when it is asked for.
      Effect.suspend(() => {
        const waitedMs = Date.now() - asked
        if (waitedMs > WAIT_LOG_MS) {
          // A refresh that was really queued behind a scheduled rebuild otherwise looks like a slow
          // rebuild, and the two have different fixes.
          logger.debug('waited for another dust sync on this wallet to finish', {
            origin: ORIGIN,
            groupId,
            accountIndex,
            waitedMs,
          })
        }
        return sync
      }),
    )
  })
