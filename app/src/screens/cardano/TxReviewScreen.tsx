/**
 * The single review funnel for **every** signature the app produces, and on
 * confirm the one ceremony that signs them — one biometric prompt — reporting the
 * outcome back to the producer via its handoff ticket.
 *
 * Two subjects, because a signature is not always over a transaction:
 *
 * - a **transaction** (send / stake / swap / consolidation / DUST / dApp
 *   `signTx`), rendered by `TxReview`, or by `CeremonyReview` when a producer
 *   queued several legs;
 * - a **message** (CIP-8 / CIP-30 `signData`), rendered by `MessageReview`.
 *
 * The exceptions are enumerated and deliberate: the four app-infrastructure
 * signers over the ID slot (Koios / SteelSwap / SIWM) sign server challenges
 * without review, and `CoSignScreen` still reviews inline pending its move here.
 * Everything else arrives as a ticket. See `docs/mobile-shell-plan.md` item 41.
 *
 * @module
 */

import type {SigningSuccess} from '@pnyx/signing-service'
import {Stack, useLocalSearchParams, useRouter} from 'expo-router'
import {useCallback, useMemo, useRef, useState} from 'react'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons/Button'
import {Callout} from '../../components/Callout'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {StickyFooter} from '../../components/StickyFooter'
import {Typography} from '../../components/Typography'
import {useModelReady} from '../../hooks/useModelAvailability'
import {useToast} from '../../hooks/useToast'
import type {TranslationKey} from '../../i18n/types'
import {logger} from '../../logger'
import {copyToClipboard} from '../../platform/clipboard'
import {useI18n} from '../../providers'
import {signWithCeremony} from '../../services/cardano'
import {
  type CeremonyFailureStage,
  ceremonyFailureReason,
  ceremonyFailureStage,
  rawFailureText,
  submitFailureDetail,
} from '../../services/cardano/submit-failure'
import {CeremonyReview} from './CeremonyReview'
import {ExplainTxAction} from './ExplainTxAction'
import {MessageReview, TxReview} from './review'
import {consumeReviewTicket, doneDestination, isMessageLeg, peekReviewTicket, type ReviewTicket} from './review-handoff'
import {reviewScreenTitleKey, willBroadcastOnConfirm} from './review-model'

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {
    padding: spacing.spacing16,
    gap: spacing.spacing12,
  },
  cannotSign: {
    color: colors.textAlternative,
    textAlign: 'center',
    paddingBottom: spacing.spacing16,
  },
}))

/**
 * What a failed ceremony is called, by the step that failed.
 *
 * ⚠️ **One key for all of them said the network had rejected the transaction.** It is the right
 * sentence for a `SigningBroadcastError` and wrong for every other arm: a Trezor the app could not
 * reach was reported as *"The network rejected this transaction: … No Trezor devices found"*, about a
 * transaction that had not been built, and a user who declined on their own device was told the same.
 * `'declined'` takes no reason because the device's text adds nothing to the user's own decision; the
 * extra `reason` value is inert against a template that does not name it.
 */
const FAILURE_MESSAGE_KEY = {
  broadcast: 'txReview.outcome.rejectedReason',
  device: 'txReview.outcome.deviceFailedReason',
  declined: 'txReview.outcome.declinedOnDevice',
  locked: 'txReview.outcome.deviceLocked',
  other: 'txReview.outcome.signFailedReason',
} as const satisfies Record<CeremonyFailureStage, TranslationKey>

/** The legs a failed ceremony had already broadcast, if it reported any. */
const landedLegsOf = (error: unknown): readonly SigningSuccess[] =>
  typeof error === 'object' && error !== null && 'completed' in error
    ? ((error as {completed?: readonly SigningSuccess[]}).completed ?? [])
    : []

type Phase = 'review' | 'signing'

export const TxReviewScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const {showToast} = useToast()
  const {ticket: ticketId} = useLocalSearchParams<{ticket: string}>()

  // Read once on mount; the ticket is consumed only when an outcome is delivered.
  const ticketRef = useRef<ReviewTicket | undefined>(ticketId ? peekReviewTicket(ticketId) : undefined)
  const ticket = ticketRef.current
  const [phase, setPhase] = useState<Phase>('review')
  const [progressKey, setProgressKey] = useState<string | null>(null)

  const legs = ticket?.legs ?? []
  // Only what this producer declared; anything it did not expect still warns.
  const expectedWarnings = useMemo(
    () => (ticket?.expectedWarnings === undefined ? undefined : new Set(ticket.expectedWarnings)),
    [ticket?.expectedWarnings],
  )
  // Only transaction legs feed the multi-leg stepper. A message subject is always
  // alone, so this is empty in that case rather than mixed.
  const transactionLegs = useMemo(() => legs.flatMap((leg) => (isMessageLeg(leg) ? [] : [leg.reviewed])), [legs])
  const [signingLeg, setSigningLeg] = useState<number | null>(null)
  const modelReady = useModelReady()
  // A rejection is too long for a toast and the user needs to be able to read it,
  // so it stays on the screen the retry button is on.
  /**
   * The rejection, as a summary to read and the node's whole text to copy.
   *
   * ⚠️ **Both, because either alone is useless.** A Plutus failure arrives as tens of kilobytes — the
   * base64 script, the `TxInfo` dump, the redeemer — and rendering that raw put an unreadable wall in a
   * one-line callout (mainnet, 2026-08-28). Condensing it alone would throw away the only thing that can
   * pin *which* check refused. So the callout shows the summary and offers the rest.
   */
  const [failure, setFailure] = useState<{
    readonly summary: string
    readonly detail: string
    readonly stage: CeremonyFailureStage
  } | null>(null)

  const settle = useCallback(
    (deliver: (ticket: ReviewTicket) => void) => {
      if (ticketId === undefined) return
      const claimed = consumeReviewTicket(ticketId)
      if (claimed) deliver(claimed)
    },
    [ticketId],
  )

  const onCancel = useCallback(() => {
    settle((claimed) => claimed.onCancel())
    router.back()
  }, [settle, router])

  const onConfirm = useCallback(async () => {
    if (!ticket || ticket.signingLayer === null) return
    const {signingLayer} = ticket
    setPhase('signing')
    setFailure(null)
    // One ceremony for every leg, not one per leg: `signWithCeremony` signs and
    // broadcasts strictly in order under a single auth prompt, and records each
    // landed leg so a partial chain stays resumable. Looping the single-request
    // helper opened a fresh ceremony per leg and skipped all of that.
    try {
      const results = await signWithCeremony(
        ticket.groupId,
        ticket.legs.map((leg) => leg.request),
        signingLayer,
        // Declared by the producer — this screen only forwards it, so it cannot relabel
        // what it is about to sign.
        ticket.audit,
        (progress, index) => {
          setProgressKey(progress.phase)
          setSigningLeg(index)
        },
        // Names the ceremony in the pending inbox; unlabelled producers keep the generic title.
        ticket.continuationContext === undefined ? undefined : {context: ticket.continuationContext},
      )
      const doneHref = ticket.doneHref
      settle((claimed) => claimed.onSettled(results))
      showToast({
        variant: 'success',
        message: results.every((r) => r._tag === 'TxSubmitted')
          ? t('txReview.outcome.submitted')
          : t('txReview.outcome.signed'),
      })
      // `dismissTo` unwinds the funnel rather than stacking home on top of it, so
      // the back gesture does not walk the user back into a completed send.
      const destination = doneDestination(doneHref)
      if (destination !== null) router.dismissTo(destination as never)
      else router.back()
    } catch (error) {
      setPhase('review')
      setProgressKey(null)
      setSigningLeg(null)
      // `SigningSequenceError` carries the legs that already landed.
      const landed = landedLegsOf(error)
      const summary = ceremonyFailureReason(error)
      const stage = ceremonyFailureStage(error)
      // ⚠️ This is the only producer of "Transaction failed" in the app, and it used to leave no trace
      // at all: a bug report whose send had in fact landed could not be told from one whose send had
      // not, because the branch that decides the user sees a failure said nothing. The reason reaches
      // the signing audit, but the audit is not in a report's log trail.
      const failureLog = {
        origin: 'TxReviewScreen',
        stage,
        landed: landed.length,
        legs: ticket.legs.length,
        reason: summary ?? String(error),
      }
      // A decline is the user's own choice, not a failure the app recovered from.
      if (stage === 'declined') logger.debug('the signing ceremony was declined', failureLog)
      else logger.warn('the signing ceremony failed', failureLog)
      // The detail is the *unsummarised* reason. Absent when the error carries no text at all, and then
      // there is nothing to copy — the callout drops its action rather than offering an empty clipboard.
      const detail = rawFailureText(error)
      setFailure(summary === null ? null : {summary, detail: detail ?? summary, stage})
      settle((claimed) => {
        // Order matters: the producer must learn what landed before it learns
        // the ceremony failed, or it cannot reconcile the partial state.
        if (landed.length > 0) claimed.onSettled(landed)
        claimed.onError(error)
      })
      showToast({
        variant: 'error',
        message:
          landed.length > 0
            ? `${t('txReview.outcome.failed')} ${t('txReview.ceremony.partial', {done: landed.length})}`
            : t('txReview.outcome.failed'),
      })
    }
  }, [ticket, settle, showToast, t, router])

  const first = legs[0]
  if (first === undefined) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.content}>
        <Typography variant="bodyMd_regular">{t('txReview.outcome.failed')}</Typography>
      </SafeAreaViewWrapper>
    )
  }

  // What approving actually causes, which the amounts never say on their own: a
  // `signOnly` request (dApp signTx, multisig partial sign) produces a witness set and
  // submits nothing, and a multisig leg may still be short of its quorum.
  // The transaction's own type, as the screen title. It used to be a hero inside
  // the review, directly above a `YOUR WALLET` row that repeated its amount — the
  // history detail has always put the type in the title instead, and there was no
  // reason for the signing flow to differ.
  const screenTitle = t(reviewScreenTitleKey(ticket?.titleKey, isMessageLeg(first) ? null : first.reviewed))

  const firstRequest = legs[0]?.request
  const quorum = ticket?.signatureStatus
  const willBroadcast = willBroadcastOnConfirm(firstRequest?.payload, quorum !== undefined)

  // Watch-only: everything up to signing works, and the button says so rather
  // than failing on press.
  const cannotSign = ticket?.signingLayer === null
  const cannotSignReasonKey = cannotSign ? (ticket?.cannotSignReasonKey ?? 'txReview.cannotSign.generic') : undefined

  const ctaLabel =
    progressKey === 'waiting-for-device'
      ? t('txReview.actions.waitingForDevice')
      : phase === 'signing' && legs.length > 1 && signingLeg !== null
        ? t('txReview.ceremony.signingLeg', {index: signingLeg + 1, total: legs.length})
        : progressKey === 'submitting'
          ? t('txReview.actions.submitting')
          : phase === 'signing'
            ? t('txReview.actions.signing')
            : // "Confirm & send" would be a lie for a message: nothing is sent and
              // nothing moves. It is equally a lie for a `signOnly` request — the air-gap
              // reply QR and the dApp `signTx` callback both hand a witness set back to
              // whoever submits. The label has to name what the tap actually does.
              isMessageLeg(first)
              ? t('txReview.actions.signMessage')
              : willBroadcast
                ? t('txReview.actions.confirmAndSend')
                : ticket?.signerName !== undefined
                  ? t('txReview.actions.confirmAndSignAs', {name: ticket.signerName})
                  : t('txReview.actions.confirmAndSign')

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          {cannotSignReasonKey !== undefined ? (
            <Typography variant="bodySm_regular" style={styles.cannotSign} testID="tx-review-cannot-sign">
              {t(cannotSignReasonKey as never)}
            </Typography>
          ) : null}
          <Button
            label={ctaLabel}
            onPress={onConfirm}
            fullWidth
            size="xl"
            isLoading={phase === 'signing'}
            isDisabled={phase === 'signing' || cannotSign}
            testID="tx-review-confirm"
          />
          <Button
            label={t('common.buttons.cancel')}
            variant="secondary"
            onPress={onCancel}
            fullWidth
            isDisabled={phase === 'signing'}
            testID="tx-review-cancel"
          />
        </StickyFooter>
      }
    >
      {/* Pre-sign explain. Gated on a model being available AND the user opting in, and
          on there being a transaction to explain — a message-only ticket has none. */}
      <Stack.Screen options={{title: screenTitle}} />
      {modelReady && transactionLegs.length > 0 ? (
        <Stack.Screen
          options={{
            title: screenTitle,
            headerRight: () => (
              <ExplainTxAction
                subject={{
                  legs: transactionLegs,
                  messageCount: legs.filter(isMessageLeg).length,
                  when: 'pending',
                  outcome: {
                    willBroadcast,
                    ...(quorum === undefined
                      ? {}
                      : {
                          quorum: {
                            signed: quorum.signed,
                            required: quorum.required,
                            meetsQuorum: quorum.meetsQuorum,
                          },
                        }),
                  },
                }}
              />
            ),
          }}
        />
      ) : null}
      {ticket?.noticeKey !== undefined ? (
        <Callout variant="info" message={t(ticket.noticeKey as never)} testID="tx-review-notice" />
      ) : null}
      {failure !== null ? (
        <Callout
          variant="error"
          message={t(FAILURE_MESSAGE_KEY[failure.stage], {reason: failure.summary})}
          // Offered only when there is more than the summary to give: an action that copies the sentence
          // already on screen is a button that does nothing.
          {...(failure.detail === failure.summary
            ? {}
            : {
                actionLabel: t('txReview.outcome.copyDetails'),
                actionTestID: 'tx-review-failure-copy',
                onAction: () => {
                  void copyToClipboard(submitFailureDetail(failure.detail))
                    .then(() => showToast({variant: 'info', message: t('txReview.outcome.detailsCopied')}))
                    .catch((error: unknown) => {
                      logger.warn('the rejection detail could not be copied', {
                        origin: 'TxReviewScreen',
                        error: String(error),
                      })
                    })
                },
              })}
          testID="tx-review-failure"
        />
      ) : null}
      {isMessageLeg(first) ? (
        // A message is always a single subject — nothing batches `signData` — so
        // this never has to reconcile with the multi-leg stepper below.
        <MessageReview
          message={first.message}
          addressHex={first.addressHex}
          origin={first.origin}
          requestedBy={first.requestedBy}
        />
      ) : legs.length > 1 ? (
        <CeremonyReview legs={transactionLegs} expectedWarnings={expectedWarnings} />
      ) : (
        <TxReview
          reviewed={first.reviewed}
          mode="confirm"
          signatureStatus={ticket?.signatureStatus}
          expectedWarnings={expectedWarnings}
        />
      )}
    </SafeAreaViewWrapper>
  )
}
