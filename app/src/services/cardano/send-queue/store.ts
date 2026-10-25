/**
 * Persistence for the Send compose queue.
 *
 * Rides the existing continuation store — one record per wallet group, keyed
 * `review.continuation.{groupId}.send-queue` — because a compose queue is the
 * same kind of thing: unfinished signing work that must survive process death
 * and is resumable from `PendingReviewsScreen`.
 *
 * It is *pre*-consent, so it sits at `status: 'awaiting-user'` with no
 * `signedSteps`; the legs live in `contextData`. `resumeQueue` is the only
 * read path that matters — a restored queue is untrusted (its inputs may have
 * been spent while the app was closed), so it always re-validates and never
 * hands back legs that can no longer be signed.
 *
 * @module
 */

import type {Storage, StorageError} from '@pnyx/storage'
import {Effect} from 'effect'
import {type ContinuationRecord, createContinuation} from '../continuation/record'
import {getContinuation, removeContinuation, saveContinuation} from '../continuation/store'
import {decodeLegs, SEND_QUEUE_CONTEXT, type SendQueueLeg, staleLegIds} from './model'

/** One compose queue per wallet group, so the id is fixed. */
export const QUEUE_CONTINUATION_ID = 'send-queue'

const recordFor = (groupId: string, legs: readonly SendQueueLeg[]): ContinuationRecord => ({
  ...createContinuation({
    groupId,
    continuationId: QUEUE_CONTINUATION_ID,
    context: SEND_QUEUE_CONTEXT,
    expectedStepCount: legs.length,
  }),
  contextData: {legs},
})

/** True for a continuation record that is a compose queue rather than a signing flow. */
export const isSendQueueRecord = (record: ContinuationRecord): boolean => record.context === SEND_QUEUE_CONTEXT

/** Persist the queue, or delete the record entirely when it empties. */
export const saveQueue = (
  storage: Storage,
  groupId: string,
  legs: readonly SendQueueLeg[],
): Effect.Effect<void, StorageError> =>
  legs.length === 0
    ? removeContinuation(storage, groupId, QUEUE_CONTINUATION_ID)
    : saveContinuation(storage, recordFor(groupId, legs))

export const clearQueue = (storage: Storage, groupId: string): Effect.Effect<void, StorageError> =>
  removeContinuation(storage, groupId, QUEUE_CONTINUATION_ID)

/**
 * What a restore attempt found. `Invalidated` and `Corrupt` both carry a
 * user-visible outcome: funds the user thought were committed are not, and
 * saying nothing would leave the Send flow quietly disagreeing with the banner.
 */
export type QueueResumeOutcome =
  | {readonly _tag: 'Empty'}
  | {readonly _tag: 'Restored'; readonly legs: readonly SendQueueLeg[]}
  /** Some legs could no longer be signed and were dropped (with dependents). */
  | {readonly _tag: 'Invalidated'; readonly legs: readonly SendQueueLeg[]; readonly droppedLegIds: readonly string[]}
  /** The stored payload did not decode; the record has been removed. */
  | {readonly _tag: 'Corrupt'}

/**
 * Load and re-validate the queue against the UTxOs currently spendable
 * on-chain (confirmed plus submitted-but-unconfirmed, *without* the queue
 * overlay). Prunes invalidated legs and persists the result, so a resume is
 * idempotent.
 */
export const resumeQueue = (
  storage: Storage,
  groupId: string,
  availableUtxoIds: ReadonlySet<string>,
): Effect.Effect<QueueResumeOutcome, StorageError> =>
  Effect.gen(function* () {
    const record = yield* getContinuation(storage, groupId, QUEUE_CONTINUATION_ID)
    if (record === null) return {_tag: 'Empty'} as const

    const legs = decodeLegs(record.contextData?.legs)
    if (legs === null) {
      yield* clearQueue(storage, groupId)
      return {_tag: 'Corrupt'} as const
    }
    if (legs.length === 0) {
      yield* clearQueue(storage, groupId)
      return {_tag: 'Empty'} as const
    }

    const stale = staleLegIds(legs, availableUtxoIds)
    if (stale.length === 0) return {_tag: 'Restored', legs} as const

    const dropped = new Set(stale)
    const kept = legs.filter((leg) => !dropped.has(leg.legId))
    yield* saveQueue(storage, groupId, kept)
    return {_tag: 'Invalidated', legs: kept, droppedLegIds: stale} as const
  })
