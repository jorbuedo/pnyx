/**
 * Publishing a shared wallet's CIP-146 registration on chain.
 *
 * The wallet records the *intent* at creation, because a wallet that holds
 * nothing cannot pay for its own registration. Settling it is an ordinary
 * transaction from a co-signer's own funded wallet, and so it goes through the
 * ordinary review funnel: the user sees the bytes, consents, and it is signed
 * and broadcast like anything else.
 *
 * The registry is marked `published` only once a transaction hash comes back.
 * Marking it on the way out would leave a wallet claiming to be discoverable
 * because someone opened a review screen.
 *
 * @module
 */

import {Effect} from 'effect'
import {useRouter} from 'expo-router'
import {useCallback, useEffect, useState} from 'react'
import {useCardanoRail} from '../../../hooks/useCardanoRail'
import {useCardanoSigningLayer} from '../../../hooks/useCardanoSigningLayer'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useI18n, useWalletList} from '../../../providers'
import {pendingTxFrom, registerPendingActivity} from '../../../services/cardano'
import {platformSharedWalletRegistry, type SharedWallet} from '../../../services/cardano/multisig'
import {buildRegistrationReview} from '../../../services/cardano/multisig/registration-tx'
import {registerReviewTicket} from '../review-handoff'

export type PublishRegistration = {
  readonly publish: (wallet: SharedWallet) => void
  readonly busy: boolean
  /**
   * False when the selected wallet cannot pay — a shared wallet cannot fund its
   * own registration, and a watch-only one cannot fund anything.
   *
   * ⚠️ Not the same as "publishing is unavailable": the caller can switch to a
   * wallet that *can* pay and publish then, which is what {@link publishAsPayer}
   * is for. This only says whether the wallet active right now could sign it.
   */
  readonly canPublish: boolean
  /**
   * Publish once the rail has caught up with a newly selected payer.
   *
   * The rail is built for whichever wallet is active, so a payer chosen a moment
   * ago is not ready the instant `selectWallet` resolves. Handing the intent here
   * lets the hook fire it on the render where its own rail is the payer's —
   * rather than the caller guessing a delay, which would publish from whichever
   * wallet happened to be current.
   */
  readonly publishAsPayer: (wallet: SharedWallet, payerGroupId: string) => void
}

export const usePublishRegistration = (onPublished: () => void): PublishRegistration => {
  const {t} = useI18n()
  const {showToast} = useToast()
  const router = useRouter()
  const {rail, shared} = useCardanoRail()
  const {signerKind, resolveSigningLayer} = useCardanoSigningLayer()
  const {selectedWalletGroup} = useWalletList()
  const [busy, setBusy] = useState(false)
  const groupId = selectedWalletGroup?.groupId ?? null

  // `shared === null` is the check that matters: the selected wallet must be an
  // ordinary funded one, because the whole reason this step exists is that the
  // shared wallet has nothing to pay with.
  const canPublish = rail !== null && groupId !== null && shared === null && signerKind !== null

  const run = useCallback(
    async (wallet: SharedWallet) => {
      if (rail === null || groupId === null) {
        showToast({variant: 'error', message: t('cardanoActivity.unavailable')})
        return
      }
      setBusy(true)
      try {
        // `Effect.either`, not a rejected `runPromise`: the rejection surfaces a
        // FiberFailure whose message is Effect's generic default, and the typed
        // reason — the only thing that says what went wrong — is lost with it.
        const built = await Effect.runPromise(Effect.either(buildRegistrationReview({rail, groupId, wallet})))
        if (built._tag === 'Left') {
          const reason = 'reason' in built.left ? built.left.reason : built.left.message
          logger.warn('Registration publish could not be built', {
            origin: 'PublishRegistration',
            walletId: wallet.id,
            reason,
          })
          showToast({variant: 'error', message: t('multisig.detail.publishFailed')})
          return
        }
        const review = built.right
        const signingLayer = await resolveSigningLayer(rail, groupId)
        const ticketId = registerReviewTicket({
          legs: [{reviewed: review.reviewed, request: review.request}],
          groupId,
          audit: {purpose: 'send', origin: null},
          signingLayer,
          ...(signingLayer === null ? {cannotSignReasonKey: 'txReview.cannotSign.watchOnly'} : {}),
          doneHref: '/wallet/shared-wallets',
          onSettled: (results) => {
            const result = results.length === 1 ? results[0] : undefined
            if (result?._tag !== 'TxSubmitted') return
            const submittedAt = Date.now()
            void Effect.runPromise(
              rail.pendingTracker.register(pendingTxFrom(result.txHash, review.tracked, submittedAt)),
            )
            registerPendingActivity(rail, result.txHash, review.reviewed, submittedAt)
            void Effect.runPromise(
              Effect.ignore(
                platformSharedWalletRegistry().save({
                  ...wallet,
                  registration: {status: 'published', txHash: result.txHash},
                }),
              ),
            ).then(onPublished)
          },
          onError: () => {},
          onCancel: () => {},
        })
        // Route type isn't inferred for the new group yet; narrow cast per CLAUDE.md.
        router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
      } catch (error) {
        logger.warn('Registration publish failed to build', {
          origin: 'PublishRegistration',
          walletId: wallet.id,
          message: error instanceof Error ? error.message : String(error),
        })
        showToast({variant: 'error', message: t('multisig.detail.publishFailed')})
      } finally {
        setBusy(false)
      }
    },
    [rail, groupId, resolveSigningLayer, router, onPublished, showToast, t],
  )

  /**
   * A publish waiting for its payer's rail. Cleared as soon as it fires, so a
   * later re-render — a sync, a balance update — cannot replay it.
   */
  const [pending, setPending] = useState<{readonly wallet: SharedWallet; readonly payerGroupId: string} | null>(null)

  useEffect(() => {
    if (pending === null) return
    // Wait for the rail to *be* the payer's, not merely to exist.
    if (rail === null || groupId !== pending.payerGroupId || signerKind === null) return
    setPending(null)
    void run(pending.wallet)
  }, [pending, rail, groupId, signerKind, run])

  return {
    publish: useCallback((wallet: SharedWallet) => void run(wallet), [run]),
    busy: busy || pending !== null,
    canPublish,
    publishAsPayer: useCallback((wallet: SharedWallet, payerGroupId: string) => setPending({wallet, payerGroupId}), []),
  }
}
