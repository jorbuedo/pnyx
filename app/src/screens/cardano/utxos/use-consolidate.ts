/**
 * The user-initiated Consolidate action: plan the fold, show what it will cost,
 * then hand the legs to the review ceremony.
 *
 * Planning happens before the confirmation, not after, because the numbers the
 * user is being asked to accept — how many transactions, how much fee, how many
 * coins are left out — are only knowable once the transactions are built. The
 * confirmation is therefore a real preview, not an intent.
 *
 * The optimization policy is read from storage at press time rather than held in
 * state: the settings screen may have changed it since this screen mounted.
 *
 * @module
 */

import {Cause, Effect, Exit, Option} from 'effect'
import {useRouter} from 'expo-router'
import {useCallback, useState} from 'react'
import {useCardanoSigningLayer} from '../../../hooks/useCardanoSigningLayer'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useI18n} from '../../../providers'
import type {CardanoRail} from '../../../services/cardano'
import {pendingTxFrom, registerPendingActivity} from '../../../services/cardano'
import {
  buildConsolidation,
  type ConsolidationOutcome,
  loadWalletOptimization,
} from '../../../services/cardano/consolidation'
import {signerKindOf, signsAlone} from '../../../services/cardano/signer-kind'
import {registerReviewTicket} from '../review-handoff'

export type ConsolidateApi = {
  /** The planned fold awaiting confirmation, or `null` when nothing is pending. */
  readonly preview: ConsolidationOutcome | null
  readonly planning: boolean
  /** Plan a fold and open the preview. */
  readonly plan: () => void
  /** Send the previewed legs to the review ceremony. */
  readonly confirm: () => void
  readonly dismiss: () => void
}

export const useConsolidate = (rail: CardanoRail | null, groupId: string | null): ConsolidateApi => {
  const {t} = useI18n()
  const {showToast} = useToast()
  const router = useRouter()
  const {source, resolveSigningLayer} = useCardanoSigningLayer()
  const [preview, setPreview] = useState<ConsolidationOutcome | null>(null)
  const [planning, setPlanning] = useState(false)

  const plan = useCallback(() => {
    if (rail === null || groupId === null) {
      showToast({variant: 'error', message: t('cardanoSend.errors.railUnavailable')})
      return
    }
    setPlanning(true)
    void (async () => {
      try {
        const policy = await loadWalletOptimization()
        // `runPromiseExit` so the typed failure survives — a rejected promise
        // only exposes a FiberFailure wrapper and every kind collapses into one.
        const exit = await Effect.runPromiseExit(buildConsolidation(rail, groupId, policy))
        if (Exit.isFailure(exit)) {
          const failure = Option.getOrUndefined(Cause.failureOption(exit.cause))
          const kind = failure !== undefined && 'kind' in failure ? String((failure as {kind: unknown}).kind) : null
          const reason =
            failure !== undefined && 'reason' in failure
              ? String((failure as {reason: unknown}).reason)
              : Cause.pretty(exit.cause)
          logger.warn('consolidation planning failed', {origin: 'useConsolidate', kind, reason})
          const key =
            kind === 'nothing-to-do'
              ? 'nothingToDo'
              : kind === 'empty-wallet' || kind === 'insufficient-funds'
                ? 'insufficientFunds'
                : 'failed'
          showToast({variant: kind === 'nothing-to-do' ? 'info' : 'error', message: t(`consolidate.errors.${key}`)})
          return
        }
        setPreview(exit.value)
      } finally {
        setPlanning(false)
      }
    })()
  }, [rail, groupId, showToast, t])

  const dismiss = useCallback(() => setPreview(null), [])

  const confirm = useCallback(() => {
    if (rail === null || groupId === null || preview === null) return
    const outcome = preview
    setPreview(null)
    void (async () => {
      const signingLayer = await resolveSigningLayer(rail, groupId)
      // A script wallet has no signing layer by design, same as watch-only —
      // neither is a configuration problem worth reporting.
      if (signingLayer === null && signsAlone(signerKindOf(source))) {
        logger.warn('consolidation blocked: no signer for wallet source', {
          origin: 'useConsolidate',
          source: String(source),
        })
        showToast({variant: 'error', message: t('cardanoSend.errors.railUnavailable')})
        return
      }
      const ticketId = registerReviewTicket({
        legs: outcome.legs.map((leg) => ({reviewed: leg.review.reviewed, request: leg.review.request})),
        groupId,
        audit: {purpose: 'consolidate', origin: null},
        signingLayer,
        ...(signingLayer === null ? {cannotSignReasonKey: 'txReview.cannotSign.watchOnly'} : {}),
        titleKey: 'consolidate.reviewTitle',
        // The wallet home, like every other finished ceremony: that is where the
        // pending row shows. Returning to the UTxO list looked like the fix had not
        // worked — the list cannot change until the transactions confirm.
        doneHref: '/wallets',
        onSettled: (results) => {
          const submittedAt = Date.now()
          results.forEach((result, index) => {
            if (result._tag !== 'TxSubmitted') return
            const leg = outcome.legs[index]
            if (leg === undefined) return
            void Effect.runPromise(
              rail.pendingTracker.register(pendingTxFrom(result.txHash, leg.review.tracked, submittedAt)),
            )
            // The indexer will not return these for a while, and until then the
            // user has no evidence anything happened to their coins.
            registerPendingActivity(rail, result.txHash, leg.review.reviewed, submittedAt)
          })
        },
        onError: () => {},
        onCancel: () => {},
      })
      router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
    })()
  }, [rail, groupId, preview, resolveSigningLayer, source, router, showToast, t])

  return {preview, planning, plan, confirm, dismiss}
}
