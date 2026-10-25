/**
 * Persisted review-continuation store: multi-leg signing flows that must
 * survive process death, keyed `review.continuation.{groupId}.{continuationId}`
 * over the platform storage layer. Mirrors the pending-cosign registry — a
 * prefix-scanned key/value store, no bespoke index. Non-secret metadata only
 * (ids, tx hashes, status) — never signing material.
 *
 * @module
 */

import type {Storage, StorageError} from '@pnyx/storage'
import {Effect} from 'effect'
import {logger} from '../../../logger'
import {createProfileStorage} from '../../profile/profile-storage'
import {appendSignedStep as appendStep, type ContinuationRecord, type SignedStep} from './record'

const PREFIX = 'review.continuation.'
const keyOf = (groupId: string, continuationId: string): string => `${PREFIX}${groupId}.${continuationId}`

const parse = (raw: string): ContinuationRecord | null => {
  try {
    return JSON.parse(raw) as ContinuationRecord
  } catch (e: unknown) {
    // `null` drops the record, so a half-finished ceremony disappears from the inbox rather
    // than showing as one that cannot be resumed.
    logger.warn('Continuation record could not be parsed; it will not be offered for resume', {
      origin: 'continuation/store',
      error: String(e),
    })
    return null
  }
}

export const saveContinuation = (storage: Storage, record: ContinuationRecord): Effect.Effect<void, StorageError> =>
  storage.set(keyOf(record.groupId, record.continuationId), JSON.stringify(record))

export const getContinuation = (
  storage: Storage,
  groupId: string,
  continuationId: string,
): Effect.Effect<ContinuationRecord | null, StorageError> =>
  Effect.map(storage.get(keyOf(groupId, continuationId)), (raw) => (raw === null ? null : parse(raw)))

export const removeContinuation = (
  storage: Storage,
  groupId: string,
  continuationId: string,
): Effect.Effect<void, StorageError> => storage.remove(keyOf(groupId, continuationId))

export const listContinuations = (
  storage: Storage,
  groupId?: string,
): Effect.Effect<readonly ContinuationRecord[], StorageError> =>
  Effect.gen(function* () {
    const keys = (yield* storage.keys()).filter((k) => k.startsWith(PREFIX))
    const out: ContinuationRecord[] = []
    for (const key of keys) {
      const raw = yield* storage.get(key)
      const record = raw === null ? null : parse(raw)
      if (record && (groupId === undefined || record.groupId === groupId)) out.push(record)
    }
    return out
  })

/**
 * Load, append a landed leg via the pure reducer, persist. No-op (returns the
 * loaded record) if the continuation is gone; returns null only when absent.
 */
export const appendSignedStep = (
  storage: Storage,
  groupId: string,
  continuationId: string,
  step: SignedStep,
): Effect.Effect<ContinuationRecord | null, StorageError> =>
  Effect.gen(function* () {
    const current = yield* getContinuation(storage, groupId, continuationId)
    if (current === null) return null
    const next = appendStep(current, step)
    yield* saveContinuation(storage, next)
    return next
  })

/** Bind the continuation ops to the platform storage instance (app runtime). */
export const platformContinuationStore = (): {
  readonly save: (record: ContinuationRecord) => Effect.Effect<void, StorageError>
  readonly get: (groupId: string, continuationId: string) => Effect.Effect<ContinuationRecord | null, StorageError>
  readonly remove: (groupId: string, continuationId: string) => Effect.Effect<void, StorageError>
  readonly list: (groupId?: string) => Effect.Effect<readonly ContinuationRecord[], StorageError>
  readonly appendStep: (
    groupId: string,
    continuationId: string,
    step: SignedStep,
  ) => Effect.Effect<ContinuationRecord | null, StorageError>
} => {
  const storage = createProfileStorage()
  return {
    save: (record) => saveContinuation(storage, record),
    get: (groupId, continuationId) => getContinuation(storage, groupId, continuationId),
    remove: (groupId, continuationId) => removeContinuation(storage, groupId, continuationId),
    list: (groupId) => listContinuations(storage, groupId),
    appendStep: (groupId, continuationId, step) => appendSignedStep(storage, groupId, continuationId, step),
  }
}
