/**
 * Pure aggregator for the pending-review inbox: merges the two persisted sources
 * of resumable work — under-quorum co-sign envelopes and multi-leg signing
 * continuations — into a single newest-first list. No storage, no React: the
 * hook feeds it the two lists and renders the result.
 *
 * Cosign envelopes in the registry are always resumable (a shared tx awaiting
 * more signatures) — importantly, that path *reviews* the transaction before
 * signing it.
 *
 * **Continuations are not resumable from this inbox** (Phase 16 item 41,
 * 2026-07-29). They stash **unsigned** `SigningRequest`s, so resuming meant
 * signing bytes read back out of ordinary storage with nothing shown to the
 * user — a planted or drifted record would be signed under the user's own
 * biometric. The locked rule is that a resume may re-broadcast something already
 * signed, but anything unsigned must be rebuilt and reviewed in full.
 *
 * Routing them through the review screen instead is the intended end state and is
 * deliberately **not** done here: `reviewCardanoTx` needs resolved inputs, and a
 * resumed leg's inputs may be spent or belong to a parent the indexer cannot see
 * yet, so they would render as *foreign* — telling the user their own money is
 * someone else's. That needs the chained-input provenance marker (item 49) first.
 * Shipping a misleading review would be worse than withholding the action.
 *
 * So the inbox still *surfaces* these records — what landed, what did not, and
 * why — and offers Dismiss. It no longer offers to sign them. Note this removes
 * little in practice: session-9 measurement showed a resume re-submits
 * byte-identical transactions whose inputs are already spent, so it answered
 * `400 All inputs are spent` rather than working.
 *
 * @module
 */

import type {ContinuationRecord} from '../continuation/record'
import {hasResumablePayload, isResumable} from '../continuation/record'
import {requiredFor, statusOf} from '../cosign/envelope'
import type {PendingCosign} from '../cosign/registry'
import type {SignatureStatus, TxEnvelope} from '../cosign/types'

export type PendingCosignItem = {
  readonly kind: 'cosign'
  readonly id: string
  readonly groupId: string
  readonly sortKey: number
  readonly canResume: true
  readonly envelope: TxEnvelope
  readonly status: SignatureStatus
}

export type PendingContinuationItem = {
  readonly kind: 'continuation'
  readonly id: string
  readonly groupId: string
  readonly sortKey: number
  /** Always `false` — see the module note. Signing stored unsigned bytes needs a review first. */
  readonly canResume: false
  /**
   * The record still has legs that never broadcast, so it is worth showing and
   * worth rebuilding. Distinct from {@link canResume}: it says the work is
   * outstanding, not that this surface may sign it.
   */
  readonly hasUnbroadcastLegs: boolean
  readonly record: ContinuationRecord
}

export type PendingReviewItem = PendingCosignItem | PendingContinuationItem

const sortKeyOfIso = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/** Continuation ids are `${Date.now().toString(36)}-${counter}`; recover the ms prefix. */
const sortKeyOfContinuationId = (id: string): number => {
  const prefix = id.split('-')[0] ?? ''
  const t = Number.parseInt(prefix, 36)
  return Number.isNaN(t) ? 0 : t
}

/** Merge cosign + continuation sources into one newest-first inbox list. */
export const aggregatePending = (
  cosigns: readonly PendingCosign[],
  continuations: readonly ContinuationRecord[],
): readonly PendingReviewItem[] => {
  const cosignItems: PendingReviewItem[] = cosigns.map((c) => ({
    kind: 'cosign',
    id: c.id,
    groupId: c.groupId,
    sortKey: sortKeyOfIso(c.envelope.createdAt),
    canResume: true,
    envelope: c.envelope,
    status: statusOf(c.envelope, requiredFor(c.envelope)),
  }))
  const continuationItems: PendingReviewItem[] = continuations.filter(isResumable).map((r) => ({
    kind: 'continuation',
    id: r.continuationId,
    groupId: r.groupId,
    sortKey: sortKeyOfContinuationId(r.continuationId),
    canResume: false,
    hasUnbroadcastLegs: hasResumablePayload(r),
    record: r,
  }))
  return [...cosignItems, ...continuationItems].sort((a, b) => b.sortKey - a.sortKey)
}
