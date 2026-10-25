/**
 * Turning a DUST decision into a signed ceremony.
 *
 * Registering is two transactions whenever the wallet already holds NIGHT. Only NIGHT
 * received by a transaction *posterior to* the registration generates DUST, so held NIGHT
 * has to move again — and rather than leaving that as a second thing the user must know to
 * do, it is chained onto the registration as a second leg of the same review.
 *
 * The registration's own change does not count, however much NIGHT it carries: that change
 * is an output of the registration itself, not a later receipt. So the self-send covers
 * every NIGHT UTxO the wallet holds, not just the ones the registration left untouched.
 *
 * Chaining, not merely ordering: the self-send spends the registration's change, so it
 * *cannot* be included before the registration. Submitting them in order would still allow
 * both into one block, where "received after registration" is ambiguous.
 *
 * @module
 */

import type {TransactionWarning} from '@pnyx/tx-review'
import type {UtxoOverlayEntry} from '@pnyx/wallet'
import {Effect, Exit} from 'effect'
import {useRouter} from 'expo-router'
import {useCallback, useState} from 'react'
import {useCardanoSigningLayer} from '../../../hooks/useCardanoSigningLayer'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useI18n} from '../../../providers'
import {
  buildEnhancedSendReview,
  type CardanoRail,
  pendingTxFrom,
  registerPendingActivity,
} from '../../../services/cardano'
import {NIGHT_ASSET_ID} from '../../../services/cardano/night-redeem'
import {resolveCardanoParams} from '../../../services/cardano/params'
import type {SendReview} from '../../../services/cardano/send-flow'
import {signerKindOf, signsAlone} from '../../../services/cardano/signer-kind'
import {
  buildDestinationChangeTxs,
  buildRegistrationTx,
  type CnightUtxo,
  type RegistrationIntent,
  type RegistrationUtxo,
  type TxIn,
} from '../../../services/midnight-dust'
import {failureOf} from '../../../utils/effect-failure'
import {registerReviewTicket} from '../review-handoff'
import {minAdaForOutput} from '../send/min-ada'
import {expectedFor} from './expected-warnings'

export type DustActionsApi = {
  readonly busy: boolean
  readonly run: (intent: RegistrationIntent, night: readonly CnightUtxo[]) => void
  /** The self-send alone, for a registration that already exists but generates nothing. */
  readonly activate: (night: readonly CnightUtxo[]) => void
  /** Remove every registration but the one to keep, restoring the one-per-account invariant. */
  readonly repair: (remove: readonly TxIn[]) => void
}

export const useDustActions = (
  rail: CardanoRail | null,
  groupId: string | null,
  /**
   * The account's registrations, which is where a spend's mandatory-input value comes from.
   * Without it every deregister and change-of-destination failed to build — the balancer
   * cannot account for the auth token without the value that carries it.
   */
  registrations: readonly RegistrationUtxo[] = [],
): DustActionsApi => {
  const {t} = useI18n()
  const {showToast} = useToast()
  const router = useRouter()
  const {source, resolveSigningLayer} = useCardanoSigningLayer()
  const [busy, setBusy] = useState(false)

  const valueOfRegistration = useCallback(
    (ref: TxIn): string | undefined =>
      registrations.find((r) => r.ref.txHash === ref.txHash && r.ref.index === ref.index)?.valueHex,
    [registrations],
  )

  /**
   * The self-send that makes already-held NIGHT eligible, over `composeOver` — the
   * registration leg when chained onto one, empty when activating an existing registration.
   */
  const selfSendAllNight = useCallback(
    (rail: CardanoRail, groupId: string, night: readonly CnightUtxo[], composeOver: readonly UtxoOverlayEntry[]) =>
      Effect.gen(function* () {
        // Every NIGHT the wallet holds, including any the registration's own coin selection
        // pulled in: that NIGHT lands in the registration's change, which is an output *of*
        // the registration, not a receipt after it. Eligibility is measured against a
        // transaction posterior to the registration, so it has to move again either way.
        // Targeting the full held amount also forces selection to reach every NIGHT UTxO,
        // which is what leaves none behind.
        const total = night.reduce((sum, u) => sum + u.value, 0n)
        const params = yield* resolveCardanoParams(rail).pipe(Effect.orElseSucceed(() => null))
        if (params === null) return null

        // A token-only output still needs its min-ADA floor; the amount is not the user's
        // choice here, so it comes from the ledger rule rather than a guess.
        const amounts = new Map<string, bigint>([[NIGHT_ASSET_ID, total]])
        const floor = minAdaForOutput(params.coinsPerUtxoByte, rail.account.addressHex, amounts)
        if (floor === null) return null
        amounts.set('', floor)

        return yield* buildEnhancedSendReview(rail, groupId, {
          targets: [{addressHex: rail.account.addressHex, amounts}],
          // Spending the previous leg's change is what makes this one unable to land first.
          composeOver,
        })
      }),
    [],
  )

  /** Register the built legs as one review ticket and open it. */
  const handOffToReview = useCallback(
    async (
      legs: readonly SendReview[],
      opts: {readonly expectedWarnings: readonly TransactionWarning[]; readonly noticeKey?: string},
    ) => {
      if (rail === null || groupId === null) return
      const signingLayer = await resolveSigningLayer(rail, groupId)
      // A script wallet has no signing layer by design, same as watch-only —
      // neither is a configuration problem worth reporting.
      if (signingLayer === null && signsAlone(signerKindOf(source))) {
        showToast({variant: 'error', message: t('cardanoSend.errors.railUnavailable')})
        return
      }
      const ticketId = registerReviewTicket({
        legs: legs.map((leg) => ({reviewed: leg.reviewed, request: leg.request})),
        groupId,
        audit: {purpose: 'dust', origin: null},
        signingLayer,
        ...(signingLayer === null ? {cannotSignReasonKey: 'txReview.cannotSign.watchOnly'} : {}),
        titleKey: 'midnightDust.title',
        continuationContext: 'midnight.dustRegistration',
        expectedWarnings: opts.expectedWarnings,
        ...(opts.noticeKey === undefined ? {} : {noticeKey: opts.noticeKey}),
        doneHref: '/wallet/dust',
        onSettled: (results) => {
          const submittedAt = Date.now()
          results.forEach((result, index) => {
            if (result._tag !== 'TxSubmitted') return
            const leg = legs[index]
            if (leg === undefined) return
            void Effect.runPromise(rail.pendingTracker.register(pendingTxFrom(result.txHash, leg.tracked, submittedAt)))
            registerPendingActivity(rail, result.txHash, leg.reviewed, submittedAt)
          })
        },
        onError: () => {},
        onCancel: () => {},
      })
      router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
    },
    [rail, groupId, resolveSigningLayer, source, router, showToast, t],
  )

  const run = useCallback(
    (intent: RegistrationIntent, night: readonly CnightUtxo[]) => {
      if (rail === null || groupId === null) {
        showToast({variant: 'error', message: t('cardanoSend.errors.railUnavailable')})
        return
      }
      setBusy(true)
      void (async () => {
        try {
          /**
           * ⚠️ **A destination change is two transactions, and the validator is why.** Its spend handler
           * requires the auth token to be burned, so "spend the registration and recreate it" is not an
           * operation it has — a mainnet attempt was refused, and the script itself was evaluated to
           * settle it (`build-registration.ts`). Deregister releases the token, register mints a new one
           * with the new destination.
           */
          const legsEffect: Effect.Effect<readonly SendReview[], unknown> =
            intent.kind === 'changeDestination'
              ? buildDestinationChangeTxs(
                  rail,
                  groupId,
                  {current: intent.current, dustPayload: intent.dustPayload},
                  {resolveCurrentValueHex: valueOfRegistration},
                )
              : Effect.map(
                  buildRegistrationTx(rail, groupId, intent, {resolveCurrentValueHex: valueOfRegistration}),
                  (one) => [one] as readonly SendReview[],
                )
          const exit = await Effect.runPromiseExit(legsEffect)
          if (Exit.isFailure(exit)) {
            const {kind, reason} = failureOf(exit.cause)
            logger.warn('dust registration build failed', {origin: 'useDustActions', kind, reason})
            showToast({variant: 'error', message: t('midnightDust.errors.buildFailed')})
            return
          }
          const registrationLegs = exit.value
          const registration = registrationLegs[registrationLegs.length - 1] as SendReview

          // Only a fresh registration can strand existing NIGHT: changing the destination
          // and deregistering do not move the eligibility boundary. And for a registration
          // that has not happened yet, *every* NIGHT already held predates it — no slot
          // comparison needed, since the registration's slot is still in the future.
          let activation: SendReview | null = null
          if (intent.kind === 'register' && night.length > 0) {
            const built = await Effect.runPromiseExit(selfSendAllNight(rail, groupId, night, [registration.tracked]))
            if (Exit.isSuccess(built)) activation = built.value
            else {
              // The registration is still worth submitting on its own; the screen will keep
              // reporting that the NIGHT needs activating.
              logger.warn('dust activation leg could not be built', {
                origin: 'useDustActions',
                reason: failureOf(built.cause).reason,
              })
            }
          }

          // `registration` above is the LAST leg, which is the one a fresh registration chains from.
          const legs = activation === null ? [...registrationLegs] : [...registrationLegs, activation]
          // Definitional for this operation, so they carry no information as alarms: a
          // registration *is* a mint (the auth token is the registration), it *is* a script
          // call, and its fee looks disproportionate only because the ratio test measures fee
          // against value sent while this sends almost nothing — the min-ADA at the validator
          // is a reclaimable deposit, not a payment. The fee itself is still on screen in its
          // own row. Anything unexpected still warns.
          await handOffToReview(legs, {
            expectedWarnings: expectedFor(intent.kind),
            // Only when there is a second leg to explain.
            ...(activation !== null
              ? {noticeKey: 'midnightDust.activationChained' as const}
              : registrationLegs.length > 1
                ? {noticeKey: 'midnightDust.destinationChangeChained' as const}
                : {}),
          })
        } finally {
          setBusy(false)
        }
      })()
    },
    [rail, groupId, selfSendAllNight, valueOfRegistration, handOffToReview, showToast, t],
  )

  /**
   * The self-send on its own — the registration already exists, but every NIGHT the account
   * holds predates it, so none of it generates until it moves again.
   */
  const activate = useCallback(
    (night: readonly CnightUtxo[]) => {
      if (rail === null || groupId === null || night.length === 0) {
        showToast({variant: 'error', message: t('cardanoSend.errors.railUnavailable')})
        return
      }
      setBusy(true)
      void (async () => {
        try {
          // No registration leg to chain onto: this stands alone, so `composeOver` is empty
          // and the send draws straight from confirmed UTxOs.
          const built = await Effect.runPromiseExit(selfSendAllNight(rail, groupId, night, []))
          if (Exit.isFailure(built) || built.value === null) {
            const reason = Exit.isFailure(built) ? failureOf(built.cause).reason : 'no min-ADA floor'
            logger.warn('dust activation build failed', {origin: 'useDustActions', reason})
            showToast({variant: 'error', message: t('midnightDust.errors.buildFailed')})
            return
          }
          await handOffToReview([built.value], {expectedWarnings: []})
        } finally {
          setBusy(false)
        }
      })()
    },
    [rail, groupId, selfSendAllNight, handOffToReview, showToast, t],
  )

  /**
   * Remove every registration but one. Chained rather than merged into a single burn of N:
   * a one-per-transaction deregister is the same shape the single case already builds, and
   * introducing a second, untested script interaction to save fees is the wrong trade while
   * none of this has been accepted by a node.
   */
  const repair = useCallback(
    (remove: readonly TxIn[]) => {
      if (rail === null || groupId === null || remove.length === 0) {
        showToast({variant: 'error', message: t('cardanoSend.errors.railUnavailable')})
        return
      }
      setBusy(true)
      void (async () => {
        try {
          const legs: SendReview[] = []
          for (const current of remove) {
            const exit = await Effect.runPromiseExit(
              buildRegistrationTx(
                rail,
                groupId,
                {kind: 'deregister', current},
                {
                  resolveCurrentValueHex: valueOfRegistration,
                  // Each leg spends the previous one's change, which is what forces the
                  // ledger to accept them in order rather than as independent transactions.
                  composeOver: legs.map((leg) => leg.tracked),
                },
              ),
            )
            if (Exit.isFailure(exit)) {
              const {kind, reason} = failureOf(exit.cause)
              logger.warn('dust repair leg build failed', {origin: 'useDustActions', kind, reason})
              showToast({variant: 'error', message: t('midnightDust.errors.buildFailed')})
              return
            }
            legs.push(exit.value)
          }
          await handOffToReview(legs, {expectedWarnings: expectedFor('deregister')})
        } finally {
          setBusy(false)
        }
      })()
    },
    [rail, groupId, valueOfRegistration, handOffToReview, showToast, t],
  )

  return {busy, run, activate, repair}
}
