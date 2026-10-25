/**
 * Auth-ceremony wrapper around the signing service: one `beginCeremony` spans
 * every leg of a `signAll`, so the user authenticates once (the first vault
 * retrieve populates the ceremony cache; later legs hit the fast-path).
 *
 * Multi-leg flows (`requests.length > 1`) also persist a review continuation:
 * a durable record advanced one broadcast at a time so an interrupted
 * tx-chaining flow can be surfaced/resumed after process death. Persistence is
 * best-effort — a storage failure never blocks signing. A fully-completed flow
 * is removed; an incomplete/errored one is kept for the resume surface (a
 * follow-up UI/inbox consumes `listContinuations`).
 *
 * Every settled ceremony — successful or not — also appends one signing-audit
 * entry (`docs/SIGNING_AUDIT.md`). This is the single chokepoint for funds
 * signatures in the app, which is why the audit context is a required argument
 * rather than an option.
 *
 * @module
 */

import type {SequenceProgressFn, SigningRequest, SigningSuccess} from '@pnyx/signing-service'
import {SigningServiceTag} from '@pnyx/signing-service'
import {Cause, Effect, Exit, type Layer, Option} from 'effect'
import {beginCeremony} from '../credential-vault/ceremony-cache'
import {recordSigningAudit, type SigningAuditContext} from '../signing-audit'
import {
  appendSignedStepPure,
  type ContinuationRecord,
  createContinuation,
  markBroadcasting,
  markError,
  platformContinuationStore,
} from './continuation'
import {parseStoredSigningRequests} from './stored-request'
import {ceremonyFailureReason} from './submit-failure'

/** Optional labelling for the persisted continuation of a multi-leg flow. */
export type ContinuationContext = {
  readonly context?: string
  readonly returnTo?: string
  readonly contextData?: Record<string, unknown>
  /**
   * Continue an existing record instead of minting a new id.
   *
   * A resume that omits this writes a *second* record for the same ceremony and leaves the
   * first behind — the original is only removed on success — so the inbox grew by one row on
   * every failed retry.
   */
  readonly continuationId?: string
}

let continuationCounter = 0
const nextContinuationId = (): string => {
  continuationCounter += 1
  return `${Date.now().toString(36)}-${continuationCounter.toString(36)}`
}

/**
 * Build the durable continuation record for a multi-leg request set, stashing the
 * (JSON-serializable) `requests` in `contextData` so a later resume can
 * reconstruct the not-yet-broadcast legs. This is what makes the resume rail real
 * — a future multi-leg producer (e.g. swap) inherits reconstructable legs for free.
 */
export const continuationForRequests = (
  groupId: string,
  continuationId: string,
  requests: readonly SigningRequest[],
  continuation?: ContinuationContext,
): ContinuationRecord =>
  createContinuation({
    groupId,
    continuationId,
    context: continuation?.context ?? 'cardano.signAll',
    expectedStepCount: requests.length,
    ...(continuation?.returnTo !== undefined ? {returnTo: continuation.returnTo} : {}),
    contextData: {...(continuation?.contextData ?? {}), requests},
  })

/**
 * The not-yet-broadcast legs of a continuation, read back from the `requests`
 * stashed in `contextData`. Returns `null` when the record carries no
 * reconstructable payload (nothing to resume) — never fabricates legs.
 *
 * The stored entries are **validated, not cast**: this is data coming back from
 * ordinary storage, and it is destined for the signer. A record whose shape
 * doesn't match what we write is unusable rather than repairable, so the whole
 * array is rejected (see `stored-request.ts` for why partial acceptance would be
 * worse than none).
 */
export const resumableRequests = (record: ContinuationRecord): readonly SigningRequest[] | null => {
  const stashed = parseStoredSigningRequests(record.contextData?.requests)
  if (stashed === null) return null
  const remaining = stashed.slice(record.currentStepIndex)
  return remaining.length > 0 ? remaining : null
}

// The typed failures are `Data.TaggedError`s, whose `message` is Effect's generic default —
// so the reason has to be read from the payload, not from `message`.
const errMessage = (error: unknown): string =>
  ceremonyFailureReason(error) ?? (error instanceof Error ? error.message : String(error))

/**
 * Sign (and per-payload broadcast) `requests` strictly in order under a single
 * auth ceremony. Rejects with the service's typed errors
 * (`SigningSequenceError` carries completed legs).
 *
 * `audit` is **required**, and that is the enforcement: every funds signature in
 * the app funnels through here, so a new producer cannot reach a signature without
 * declaring why it is signing and on whose behalf. The entry itself is derived from
 * the requests and results (see `signing-audit/record.ts`) — the caller declares
 * only the purpose and the origin, and can misreport neither the subject nor the
 * outcome.
 */
export const signWithCeremony = (
  groupId: string,
  requests: readonly SigningRequest[],
  signingLayer: Layer.Layer<SigningServiceTag>,
  audit: SigningAuditContext,
  onProgress?: SequenceProgressFn,
  continuation?: ContinuationContext,
): Promise<readonly SigningSuccess[]> => {
  const handle = beginCeremony(groupId)
  const persist = requests.length > 1 ? platformContinuationStore() : null
  const continuationId = persist === null ? null : (continuation?.continuationId ?? nextContinuationId())

  let record: ContinuationRecord | null =
    persist === null || continuationId === null
      ? null
      : continuationForRequests(groupId, continuationId, requests, continuation)

  const savePersisted = (next: ContinuationRecord): void => {
    if (persist === null) return
    record = next
    void Effect.runPromise(Effect.ignore(persist.save(next)))
  }

  if (record !== null) savePersisted(record)

  // Advance to 'broadcasting' as each leg reaches submit — resume granularity.
  const progress: SequenceProgressFn | undefined =
    persist === null && onProgress === undefined
      ? undefined
      : (p, index) => {
          onProgress?.(p, index)
          if (record !== null && p.phase === 'submitting' && record.status !== 'broadcasting') {
            savePersisted(markBroadcasting(record))
          }
        }

  // `runPromiseExit` + unwrap, never `runPromise`: a rejected `runPromise` hands the caller a
  // FiberFailure, which carries neither the typed error's `completed` legs nor its `reason` —
  // its `message` is Effect's generic default. That silently broke three things at once: the
  // legs that had already landed were not recorded, the persisted record stored the default
  // text, and the review screen showed it to the user. Throwing the typed failure keeps the
  // existing throw-based contract while letting callers read the error they were written for.
  return Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* SigningServiceTag
      return yield* service.signAll(requests, progress)
    }).pipe(Effect.provide(signingLayer)),
  )
    .then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value
      throw Option.getOrElse(Cause.failureOption(exit.cause), () => new Error(Cause.pretty(exit.cause)))
    })
    .then((results) => {
      // Best-effort and deliberately not awaited: the signature has already happened, so a
      // storage failure must not turn a broadcast send into a rejected promise. `recordSigningAudit`
      // swallows its own errors.
      void recordSigningAudit({context: audit, requests, results})
      if (persist !== null && continuationId !== null && record !== null) {
        let next = record
        results.forEach((result, index) => {
          if (result._tag === 'TxSubmitted')
            next = appendSignedStepPure(next, {stepId: String(index), txHash: result.txHash})
        })
        // A fully-landed chain needs no resume record; keep partial/pending ones.
        if (next.status === 'completed') void Effect.runPromise(Effect.ignore(persist.remove(groupId, continuationId)))
        else savePersisted(next)
      }
      return results
    })
    .catch((error: unknown) => {
      const landed =
        typeof error === 'object' && error !== null && 'completed' in error
          ? (error as {completed?: readonly SigningSuccess[]}).completed
          : undefined
      // A failed ceremony is the case the log matters most for: legs that already broadcast are
      // recorded with the reason the rest did not.
      void recordSigningAudit({
        context: audit,
        requests,
        results: landed ?? [],
        failureReason: errMessage(error),
      })
      if (persist !== null && record !== null) {
        let next = record
        const completed = landed
        completed?.forEach((result, index) => {
          if (result._tag === 'TxSubmitted')
            next = appendSignedStepPure(next, {stepId: String(index), txHash: result.txHash})
        })
        savePersisted(markError(next, errMessage(error)))
      }
      throw error
    })
    .finally(() => handle.close())
}

/** Single-request convenience over {@link signWithCeremony}. */
export const signTxWithCeremony = async (
  groupId: string,
  request: SigningRequest,
  signingLayer: Layer.Layer<SigningServiceTag>,
  audit: SigningAuditContext,
  onProgress?: (progress: Parameters<SequenceProgressFn>[0]) => void,
): Promise<SigningSuccess> => {
  const results = await signWithCeremony(
    groupId,
    [request],
    signingLayer,
    audit,
    onProgress ? (progress) => onProgress(progress) : undefined,
  )
  const first = results[0]
  if (first === undefined) throw new Error('signing produced no result')
  return first
}
