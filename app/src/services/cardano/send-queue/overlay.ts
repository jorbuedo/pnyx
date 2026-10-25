/**
 * The bridge between the pure queue model and the rail: turning a built send
 * into a queued leg, and queued legs back into the UTxO overlay the next build
 * layers on.
 *
 * Change UTxOs are rebuilt here rather than read from storage — see the module
 * doc on `./model` for why nothing unserializable is persisted. The outpoint
 * comes from `changeUtxoIds`, which the build recorded from what the balancer
 * actually emitted; nothing here assumes where change landed.
 *
 * @module
 */

import type {CborError} from '@evolution-sdk/review/Errors'
import {type UtxoOverlayEntry, utxoId} from '@pnyx/wallet'
import {Effect} from 'effect'
import type {CardanoRail} from '../rail'
import {type ChangeOutput, changeAssets, changeUtxosFromPlan, changeValueHex, type SendReview} from '../send-flow'
import type {SendQueueLeg} from './model'

/**
 * Freeze a built send into a queue leg. `legId` is caller-supplied so the
 * producer controls identity (and so this stays pure of clocks and randomness).
 */
export const legFromSendReview = (
  review: Pick<SendReview, 'txHash' | 'request' | 'tracked' | 'changePlan'>,
  legId: string,
  queuedAt: number,
): SendQueueLeg => ({
  legId,
  txHash: review.txHash,
  request: review.request,
  consumedUtxoIds: review.tracked.consumedUtxoIds,
  changeUtxoIds: review.tracked.change.map(utxoId),
  // Encoded here: the queue is storage, and hex is its format.
  changeOutputs: review.changePlan.changeOutputs.map(({index, assets}) => ({index, valueHex: changeValueHex(assets)})),
  queuedAt,
})

/**
 * A queued leg's change outputs as full outpoints. The tx hash is the leg's own —
 * the body hash is fixed at build time, so change always lands in this leg.
 *
 * This used to reverse the outpoint out of `changeUtxoIds[0]` by splitting the id
 * string, which both assumed a single change output and re-derived data the build
 * already reported.
 */
const changeOutputsOf = (leg: SendQueueLeg): readonly ChangeOutput[] =>
  leg.changeOutputs.map(({index, valueHex}) => ({txHash: leg.txHash, index, assets: changeAssets(valueHex)}))

/** True when a later leg can spend this leg's change. */
export const isChainable = (leg: SendQueueLeg): boolean => leg.changeOutputs.length > 0

/**
 * Rebuild the overlay entries for a queue: each leg's locked inputs plus its
 * change, re-derived from the persisted body and change plan.
 */
export const queueOverlayEntries = (
  rail: CardanoRail,
  legs: readonly SendQueueLeg[],
): Effect.Effect<readonly UtxoOverlayEntry[], CborError> =>
  Effect.forEach(legs, (leg) =>
    Effect.map(
      changeUtxosFromPlan(rail, changeOutputsOf(leg)),
      (change) => ({consumedUtxoIds: leg.consumedUtxoIds, change}) satisfies UtxoOverlayEntry,
    ),
  )
