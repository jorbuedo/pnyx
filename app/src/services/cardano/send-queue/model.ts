/**
 * Pure model for the Send compose queue: transactions built and frozen at the
 * end of a send, but not yet consented to. A queued leg locks the UTxOs it
 * spends and offers its change to the next send, so several sends compose into
 * one ceremony reviewed together.
 *
 * A leg is frozen on queue because later legs reference its tx hash — the body
 * hash is fixed at build time (signing only adds a witness set), so editing a
 * queued leg would invalidate everything chained onto it. Discarding therefore
 * cascades, and so does staleness on resume.
 *
 * Everything here is JSON-safe: `CardanoTxPayload` is strings and numbers, and
 * change UTxOs are carried as ids only — the full `UTxO.UTxO` values are
 * re-derived from the body on resume rather than serialized.
 *
 * @module
 */

import type {CardanoTxPayload} from '@pnyx/signing-service'
import {type CascadeSpec, cascadeRemove} from '@pnyx/wallet'

/**
 * A queued leg always carries a transaction, never a `signData` payload —
 * enforced on the way in by {@link decodeLeg}, so consumers can read `bodyHex`
 * without re-narrowing.
 */
export type SendQueueRequest = {
  readonly payload: CardanoTxPayload
  readonly groupId: string
  readonly accountIndex?: number
}

/**
 * Send already caps recipients at `MAX_TARGETS`; the queue caps composed legs.
 * Not a protocol limit — a consent limit, since every leg has to be reviewed
 * together at the end.
 */
export const MAX_QUEUED_LEGS = 5

/** `ContinuationRecord.context` discriminator for a persisted compose queue. */
export const SEND_QUEUE_CONTEXT = 'cardano.send-queue'

/** One built-but-unsubmitted send, frozen and awaiting review with its siblings. */
export type SendQueueLeg = {
  readonly legId: string
  /** Body hash, hex — stable at build time, so later legs can chain onto it. */
  readonly txHash: string
  /** The signing request; `payload.bodyHex` is the transaction. */
  readonly request: SendQueueRequest
  /** `utxoId()` strings this leg spends — locked while it is queued. */
  readonly consumedUtxoIds: readonly string[]
  /** `utxoId()` strings of this leg's change, spendable by a later leg. */
  readonly changeUtxoIds: readonly string[]
  /**
   * This leg's change outputs — output index plus value CBOR — for re-deriving
   * the change UTxOs on resume. The outpoint's tx hash is {@link txHash}.
   *
   * A list, not a single value: the balancer splits change across outputs when one
   * cannot hold it, and a leg that persisted only the first would offer a later
   * leg a fraction of the change it actually has.
   */
  readonly changeOutputs: readonly {readonly index: number; readonly valueHex: string}[]
  readonly queuedAt: number
}

export const CASCADE_SPEC: CascadeSpec<SendQueueLeg> = {
  keyOf: (leg) => leg.legId,
  consumedIdsOf: (leg) => leg.consumedUtxoIds,
  producedIdsOf: (leg) => leg.changeUtxoIds,
}

export type AppendLegResult =
  | {readonly _tag: 'Appended'; readonly queue: readonly SendQueueLeg[]}
  | {readonly _tag: 'QueueFull'; readonly max: number}
  | {readonly _tag: 'DuplicateLeg'; readonly legId: string}

/** True while there is room for another leg. */
export const canQueue = (queue: readonly SendQueueLeg[]): boolean => queue.length < MAX_QUEUED_LEGS

/**
 * Append a freshly built leg. Rejects rather than truncating at the cap, and
 * rejects a leg whose id or tx hash is already queued — re-queueing the same
 * build would double-lock its inputs.
 */
export const appendLeg = (queue: readonly SendQueueLeg[], leg: SendQueueLeg): AppendLegResult => {
  if (!canQueue(queue)) return {_tag: 'QueueFull', max: MAX_QUEUED_LEGS}
  const clash = queue.find((q) => q.legId === leg.legId || q.txHash === leg.txHash)
  if (clash !== undefined) return {_tag: 'DuplicateLeg', legId: clash.legId}
  return {_tag: 'Appended', queue: [...queue, leg]}
}

/**
 * Discard a leg and everything chained onto it. `removedLegIds` is
 * breadth-first from the discarded leg, so it comes first.
 */
export const discardLeg = (
  queue: readonly SendQueueLeg[],
  legId: string,
): {readonly removedLegIds: readonly string[]; readonly kept: readonly SendQueueLeg[]} => {
  const {removedKeys, kept} = cascadeRemove(queue, CASCADE_SPEC, [legId])
  return {removedLegIds: removedKeys, kept}
}

/**
 * Legs that can no longer be signed, given the UTxOs currently spendable
 * on-chain (confirmed plus submitted-but-unconfirmed, *without* the queue
 * overlay — a queued leg's own inputs are still unspent).
 *
 * A leg holds if every input is either still available or produced by an
 * earlier queued leg. The first leg that fails invalidates its dependents too,
 * so the result cascades. Empty means the whole queue is still resumable.
 */
export const staleLegIds = (
  queue: readonly SendQueueLeg[],
  availableUtxoIds: ReadonlySet<string>,
): readonly string[] => {
  const producedByEarlier = new Set<string>()
  const roots: string[] = []
  for (const leg of queue) {
    const inputsHold = leg.consumedUtxoIds.every((id) => availableUtxoIds.has(id) || producedByEarlier.has(id))
    if (inputsHold) {
      for (const id of leg.changeUtxoIds) producedByEarlier.add(id)
    } else {
      roots.push(leg.legId)
    }
  }
  if (roots.length === 0) return []
  return cascadeRemove(queue, CASCADE_SPEC, roots).removedKeys
}

// ---------------------------------------------------------------------------
// Decoding persisted legs
//
// `ContinuationRecord.contextData` is `Record<string, unknown>`, so a restored
// queue is untrusted input. These validate rather than cast: a leg that does
// not round-trip is a decode failure, never a leg with invented defaults.
// ---------------------------------------------------------------------------

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isChangeOutputArray = (value: unknown): value is SendQueueLeg['changeOutputs'] =>
  Array.isArray(value) &&
  value.every((item) => {
    if (typeof item !== 'object' || item === null) return false
    const out = item as {index?: unknown; valueHex?: unknown}
    return (
      typeof out.index === 'number' && Number.isInteger(out.index) && out.index >= 0 && typeof out.valueHex === 'string'
    )
  })

const isCardanoTxRequest = (value: unknown): value is SendQueueRequest => {
  if (typeof value !== 'object' || value === null) return false
  const request = value as {payload?: unknown; groupId?: unknown}
  if (typeof request.groupId !== 'string') return false
  if (typeof request.payload !== 'object' || request.payload === null) return false
  const payload = request.payload as {_tag?: unknown; bodyHex?: unknown; networkId?: unknown}
  return payload._tag === 'CardanoTx' && typeof payload.bodyHex === 'string' && typeof payload.networkId === 'number'
}

/** Validate one persisted leg. `null` when the shape does not hold. */
export const decodeLeg = (value: unknown): SendQueueLeg | null => {
  if (typeof value !== 'object' || value === null) return null
  const leg = value as Record<string, unknown>
  if (typeof leg.legId !== 'string' || leg.legId === '') return null
  if (typeof leg.txHash !== 'string' || leg.txHash === '') return null
  if (!isCardanoTxRequest(leg.request)) return null
  if (!isStringArray(leg.consumedUtxoIds) || leg.consumedUtxoIds.length === 0) return null
  if (!isStringArray(leg.changeUtxoIds)) return null
  if (!isChangeOutputArray(leg.changeOutputs)) return null
  if (typeof leg.queuedAt !== 'number' || !Number.isFinite(leg.queuedAt)) return null
  return {
    legId: leg.legId,
    txHash: leg.txHash,
    request: leg.request,
    consumedUtxoIds: leg.consumedUtxoIds,
    changeUtxoIds: leg.changeUtxoIds,
    changeOutputs: leg.changeOutputs,
    queuedAt: leg.queuedAt,
  }
}

/**
 * Validate a persisted queue. `null` when the payload is not an array or *any*
 * leg fails to decode — a partially-decoded queue would silently drop legs
 * whose inputs are still locked elsewhere, so the whole thing is rejected.
 */
export const decodeLegs = (value: unknown): readonly SendQueueLeg[] | null => {
  if (!Array.isArray(value)) return null
  if (value.length > MAX_QUEUED_LEGS) return null
  const legs: SendQueueLeg[] = []
  for (const item of value) {
    const leg = decodeLeg(item)
    if (leg === null) return null
    legs.push(leg)
  }
  return legs
}
