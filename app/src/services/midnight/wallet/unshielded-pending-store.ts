/**
 * Unshielded UTxOs an in-flight transaction has consumed, so nothing else selects them.
 *
 * Midnight's unshielded rail had no notion of this at all: selection read the whole synced set, and two
 * sends issued before the first confirmed picked the same output — the second rejected by the node,
 * and, once a send pays its own fee, a DUST spend wasted on a transaction that could never land.
 *
 * ## Persisted, unlike Cardano's
 *
 * Cardano's `PendingTxTracker` holds the same information in an Effect `Ref`, so a restart between
 * submitting and the first sync that sees the transaction loses every lock. A Midnight confirmation can
 * be minutes away and the app is a phone that gets backgrounded, so this one is on disk from the start.
 *
 * ## Expiry is the transaction's own TTL
 *
 * Not a policy timeout. Before the TTL the transaction can still be accepted, and releasing its inputs
 * would invite a genuine double-spend; after it the node can never accept it, so holding them costs the
 * user their funds for no reason. The builder already sets a one-hour TTL and it travels with the lock.
 *
 * ## Locks only, for now
 *
 * Cardano's overlay also exposes an in-flight transaction's change as *virtual* UTxOs, so a dependent
 * transaction can be built before the first confirms. That needs the outpoints of the transaction's own
 * outputs, and the Midnight builders report identifiers rather than outpoints — a device-built
 * transaction has no hash to derive them from. Adding it needs a native reader; until then `change` is
 * empty here and the projection degrades to `confirmed − locked`, which is the half that prevents a
 * double-spend.
 *
 * @module
 */

import {Data, Effect} from 'effect'

import {logger} from '../../../logger'
import {storage} from '../../../platform/storage'
import {publishStoreChange} from '../../store-change'
import type {UnshieldedUtxo} from './unshielded-utxo-set'

const ORIGIN = 'midnight-unshielded-pending'

/**
 * The lock file could not be read or written.
 *
 * ⚠️ A *malformed* row is not this — {@link parseStoredLocks} drops it and says so, because refusing the
 * whole file would lock the wallet out of every input it owns. This is storage failing, which leaves the
 * caller free to choose: selection falls back to the confirmed set, a submit must not.
 */
export class UnshieldedLockError extends Data.TaggedError('UnshieldedLockError')<{
  readonly reason: string
}> {}

/** `@pnyx/midnight/unshielded-pending/<groupId>/<accountIndex>`. */
export const unshieldedPendingKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/unshielded-pending/${groupId}/${accountIndex}`

/** One in-flight transaction's effect on this wallet's unshielded set. */
export type UnshieldedLock = {
  /** `intentHash:outputIndex` of every UTxO the transaction spends. */
  readonly consumedUtxoIds: readonly string[]
  /** Unix seconds after which the transaction can never be accepted — its own TTL. */
  readonly expiresAt: number
  /** The transaction's identifiers, so a landing can be recognised. It has no hash. */
  readonly identifiers: readonly string[]
}

/** The id a UTxO is locked under. Must match what selection sees, so it is derived the same way. */
export const unshieldedUtxoId = (utxo: UnshieldedUtxo): string => `${utxo.intentHash}:${utxo.outputIndex}`

type StoredLock = {consumedUtxoIds?: unknown; expiresAt?: unknown; identifiers?: unknown}

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

/**
 * Decode the stored locks, dropping any row that is not readable.
 *
 * A dropped row **unlocks** its inputs, which is the direction that can double-spend — so it is logged
 * at `warn` rather than passed over. The alternative, refusing to read the whole file, would lock the
 * wallet out of every input it owns because one row went bad.
 */
export const parseStoredLocks = (raw: string | null): readonly UnshieldedLock[] => {
  if (raw === null || raw === '') return []
  let rows: unknown
  try {
    rows = JSON.parse(raw)
  } catch (error) {
    logger.warn('the unshielded lock file is not JSON; treating every input as unlocked', {
      origin: ORIGIN,
      error: String(error),
    })
    return []
  }
  if (!Array.isArray(rows)) {
    logger.warn('the unshielded lock file is not a list; treating every input as unlocked', {origin: ORIGIN})
    return []
  }
  const out: UnshieldedLock[] = []
  for (const row of rows as StoredLock[]) {
    if (!isStringList(row.consumedUtxoIds) || typeof row.expiresAt !== 'number' || !isStringList(row.identifiers)) {
      logger.warn('an unshielded lock row was malformed; its inputs are treated as unlocked', {origin: ORIGIN})
      continue
    }
    out.push({consumedUtxoIds: row.consumedUtxoIds, expiresAt: row.expiresAt, identifiers: row.identifiers})
  }
  return out
}

/** Locks still standing at `nowUnixSecs`. Pure, so the expiry rule is testable without storage. */
export const liveLocks = (locks: readonly UnshieldedLock[], nowUnixSecs: number): readonly UnshieldedLock[] =>
  locks.filter((lock) => nowUnixSecs <= lock.expiresAt)

/**
 * The locks that still stand, with expired ones swept from disk.
 *
 * Sweeping on read rather than on a timer: the only moment a stale lock matters is when something is
 * about to select inputs, and that is exactly when this is called.
 */
export const loadUnshieldedLocks = (
  groupId: string,
  accountIndex: number,
  nowUnixSecs: number,
): Effect.Effect<readonly UnshieldedLock[], UnshieldedLockError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => storage.get(unshieldedPendingKey(groupId, accountIndex)),
      catch: (error) => new UnshieldedLockError({reason: String(error)}),
    })
    const stored = parseStoredLocks(raw)
    const live = liveLocks(stored, nowUnixSecs)
    if (live.length !== stored.length) {
      logger.info('unshielded locks passed their TTL and were released', {
        origin: ORIGIN,
        groupId,
        released: stored.length - live.length,
      })
      yield* writeLocks(groupId, accountIndex, live)
    }
    return live
  })

const writeLocks = (
  groupId: string,
  accountIndex: number,
  locks: readonly UnshieldedLock[],
): Effect.Effect<void, UnshieldedLockError> =>
  Effect.tryPromise({
    try: () =>
      locks.length === 0
        ? storage.remove(unshieldedPendingKey(groupId, accountIndex))
        : storage.set(unshieldedPendingKey(groupId, accountIndex), JSON.stringify(locks)),
    catch: (error) => new UnshieldedLockError({reason: String(error)}),
  }).pipe(Effect.tap(() => publishStoreChange('midnight-unshielded-locks')))

/** Lock a submitted transaction's inputs. */
export const addUnshieldedLock = (
  groupId: string,
  accountIndex: number,
  lock: UnshieldedLock,
): Effect.Effect<void, UnshieldedLockError> =>
  Effect.gen(function* () {
    const existing = yield* loadUnshieldedLocks(groupId, accountIndex, Math.floor(Date.now() / 1000))
    logger.info('locked the inputs of an in-flight unshielded transaction', {
      origin: ORIGIN,
      groupId,
      inputs: lock.consumedUtxoIds.length,
      expiresAt: lock.expiresAt,
    })
    yield* writeLocks(groupId, accountIndex, [...existing, lock])
  })

/**
 * Release the locks of transactions the chain has now accounted for.
 *
 * Matched by identifier containment, the same rule pending sends use: a device-built transaction has no
 * hash, and a sponsored one lands carrying the sponsor's identifiers alongside ours.
 */
export const releaseUnshieldedLocks = (
  groupId: string,
  accountIndex: number,
  settledIdentifiers: readonly (readonly string[])[],
): Effect.Effect<void, UnshieldedLockError> =>
  Effect.gen(function* () {
    const now = Math.floor(Date.now() / 1000)
    const existing = yield* loadUnshieldedLocks(groupId, accountIndex, now)
    const kept = existing.filter(
      (lock) =>
        lock.identifiers.length === 0 ||
        !settledIdentifiers.some((landed) => lock.identifiers.every((id) => landed.includes(id))),
    )
    if (kept.length === existing.length) return
    logger.info('released unshielded locks for transactions the chain accounted for', {
      origin: ORIGIN,
      groupId,
      released: existing.length - kept.length,
    })
    yield* writeLocks(groupId, accountIndex, kept)
  })
