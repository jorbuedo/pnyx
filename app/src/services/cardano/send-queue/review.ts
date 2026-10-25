/**
 * Rebuilding the review IR for queued legs.
 *
 * A queued leg persists its transaction, not its review — the IR is derived, so
 * storing it would mean a second source of truth that can disagree with the
 * bytes. Re-reviewing needs each leg's inputs resolved, which is why the lookup
 * spans confirmed UTxOs, pending change, *and* earlier queued legs' change: leg
 * B's input may only exist because leg A produces it.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import {Decode} from '@evolution-sdk/review/Decode'
import type {CborError} from '@evolution-sdk/review/Errors'
import {type ReviewedTransaction, reviewCardanoTx} from '@pnyx/tx-review'
import {utxoId} from '@pnyx/wallet'
import {Data, Effect} from 'effect'
import type {CardanoRail} from '../rail'
import {unconfirmedTxHashesOf, walletUtxoToResolvedInput} from '../send-flow'
import type {SendQueueLeg} from './model'
import {queueOverlayEntries} from './overlay'

export class QueueReviewError extends Data.TaggedError('QueueReviewError')<{
  readonly reason: string
}> {}

/**
 * Re-review every queued leg, in order. Fails rather than reviewing a leg whose
 * inputs cannot all be resolved — a partial IR would misstate what the user is
 * consenting to.
 */
export const reviewQueuedLegs = (
  rail: CardanoRail,
  legs: readonly SendQueueLeg[],
): Effect.Effect<readonly ReviewedTransaction[], QueueReviewError | CborError> =>
  Effect.gen(function* () {
    if (legs.length === 0) return []

    const protocolParams = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new QueueReviewError({reason: e.message})),
    )
    const confirmed = yield* rail.spendableUtxos
    const entries = yield* queueOverlayEntries(rail, legs)

    const byId = new Map<string, UTxO.UTxO>()
    for (const utxo of confirmed) byId.set(utxoId(utxo), utxo)
    for (const entry of entries) for (const utxo of entry.change) byId.set(utxoId(utxo), utxo)

    const unconfirmed = yield* unconfirmedTxHashesOf(rail)
    const out: ReviewedTransaction[] = []
    for (const leg of legs) {
      const inputs: UTxO.UTxO[] = []
      for (const id of leg.consumedUtxoIds) {
        const utxo = byId.get(id)
        if (utxo === undefined) {
          return yield* Effect.fail(
            new QueueReviewError({reason: `queued leg ${leg.legId} references unknown input ${id}`}),
          )
        }
        inputs.push(utxo)
      }
      const reviewed = yield* reviewCardanoTx(
        leg.request.payload.bodyHex,
        rail.account.walletContext,
        inputs.map((u) => walletUtxoToResolvedInput(u, rail.account.addressHex, unconfirmed)),
        protocolParams,
        undefined,
        // No fee breakdown: it belongs to the build that produced this body and
        // is not persisted, so the review falls back to the flat cap.
        undefined,
        leg.request.payload.auxHex,
      ).pipe(
        Effect.mapError((e) => new QueueReviewError({reason: e.message})),
        Effect.provideService(Decode, rail.decode),
      )
      out.push(reviewed)
    }
    return out
  })
