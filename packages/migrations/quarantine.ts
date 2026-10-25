/**
 * Quarantine side-effect.
 *
 * When a stored blob can't be loaded (parse failure, unknown version, a
 * migration threw, final shape fails validation), we don't delete it. We
 * move it to a sibling `{key}:quarantined:{iso-timestamp}` key so it can
 * be inspected later — by a human looking at Sentry, or by a recovery
 * tool. The original key is then removed, so the caller sees "no data,
 * treat as fresh".
 *
 * Older quarantine siblings are pruned on every quarantine so a boot loop
 * (or a mass-deployed bad migration) can't grow storage unboundedly. See
 * {@link QUARANTINE_KEEP} for the retention count.
 *
 * @module
 */

import {getLogger} from '@pnyx/logger'
import {Storage, type StorageError} from '@pnyx/storage/types'
import {Effect} from 'effect'

const logger = getLogger('migrations')

/**
 * How many quarantine siblings to retain per key. Older copies are pruned
 * on every fresh quarantine. Three is enough to diagnose a pattern (first
 * failure, next failure, current) without letting a persistent corruption
 * balloon storage.
 */
export const QUARANTINE_KEEP = 3

const QUARANTINE_INFIX = ':quarantined:'

const buildQuarantineKey = (key: string, now: Date): string => `${key}${QUARANTINE_INFIX}${now.toISOString()}`

/**
 * Find quarantine siblings of `key`. Returned in ascending timestamp order
 * (oldest first), so callers can prune the prefix and keep the tail.
 */
const listQuarantineSiblings = (key: string): Effect.Effect<ReadonlyArray<string>, StorageError, Storage> =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const prefix = `${key}${QUARANTINE_INFIX}`
    const all = yield* storage.keys()
    // The ISO-8601 timestamp format sorts lexicographically in chronological
    // order, so a plain string sort is correct here.
    return all.filter((k) => k.startsWith(prefix)).sort()
  })

/**
 * Move the raw (unparsed) value at `key` to a quarantine sibling, delete
 * the original, and prune older siblings so only {@link QUARANTINE_KEEP}
 * copies remain.
 *
 * Every individual storage op is best-effort — the guiding principle is
 * "keep the user running". If writing the quarantine copy, pruning
 * siblings, or removing the original fails, we log through no channel
 * (the caller's Effect error channel) but don't propagate: losing a
 * quarantine copy is better than blocking the app's load path on a broken
 * backend. A total-storage-failure case still settles to "caller sees
 * none" via the upstream load pipeline.
 *
 * The `rawValue` is what was already read from storage by the caller —
 * passed in so we don't have to re-read (and potentially race with another
 * writer) mid-load.
 */
export const quarantine = (
  key: string,
  rawValue: string,
  now: Date = new Date(),
): Effect.Effect<void, StorageError, Storage> =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const qKey = buildQuarantineKey(key, now)

    // Write the new quarantine copy first; best-effort so a failing write
    // doesn't stop us from clearing the original.
    yield* storage.set(qKey, rawValue).pipe(
      Effect.catchAll((e) => {
        logger.warn('Failed to write the quarantine copy; the bad value is dropped unarchived', {
          origin: 'migrations',
          key,
          error: String(e),
        })
        return Effect.void
      }),
    )

    // Prune older siblings so we keep at most QUARANTINE_KEEP copies
    // (counting the one we just wrote). Best-effort; listing or removing
    // failures here are non-fatal.
    yield* Effect.gen(function* () {
      const siblings = yield* listQuarantineSiblings(key)
      const excess = siblings.length - QUARANTINE_KEEP
      if (excess <= 0) return
      const toRemove = siblings.slice(0, excess)
      for (const k of toRemove) {
        yield* storage.remove(k).pipe(
          Effect.catchAll((e) => {
            logger.warn('Failed to prune an old quarantine copy', {origin: 'migrations', key: k, error: String(e)})
            return Effect.void
          }),
        )
      }
    }).pipe(
      Effect.catchAll((e) => {
        logger.warn('Quarantine prune failed; old copies may accumulate', {
          origin: 'migrations',
          key,
          error: String(e),
        })
        return Effect.void
      }),
    )

    // Finally, remove the original. Best-effort: if this fails the caller
    // will re-quarantine on the next load; the prune step above keeps that
    // from growing unbounded.
    yield* storage.remove(key).pipe(
      Effect.catchAll((e) => {
        logger.warn('Failed to remove the quarantined original; it re-quarantines on the next load', {
          origin: 'migrations',
          key,
          error: String(e),
        })
        return Effect.void
      }),
    )
  })

export {buildQuarantineKey}
