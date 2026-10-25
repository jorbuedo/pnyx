/**
 * Review and send a Midnight transfer.
 *
 * Renders the `confirm` half of `@pnyx/tx-review`'s Midnight view model — the same model
 * `MidnightTxDetailScreen` renders after the fact, so what a transfer is said to be cannot drift
 * between the two.
 *
 * The two rails diverge here more than anywhere else, which is why the CTA has three states rather
 * than a spinner: the unshielded rail signs in milliseconds, while the shielded one proves three
 * protocol circuits on the device for ~40 s. A single "submitting…" would leave someone staring at a
 * frozen button wondering whether to force-quit.
 *
 * The fee is stated as somebody else's, because it is: Midnight fees are DUST, the phone holds none,
 * and the transaction goes out unbound for the service to balance. Saying "0" would be a lie in the
 * other direction.
 *
 * @module
 */

import {hex} from '@pnyx/crypto'
import {type MidnightConfirmView, reviewMidnightTransfer} from '@pnyx/tx-review'
import {parseMidnightAddress} from '@pnyx/wallet'
import {Cause, Effect, Exit, Option} from 'effect'
import {useLocalSearchParams, useRouter} from 'expo-router'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../../components/Buttons'
import {Callout} from '../../../components/Callout'
import {Card} from '../../../components/Card'
import {EmptyState} from '../../../components/EmptyState'
import {DataRow} from '../../../components/Row'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {StickyFooter} from '../../../components/StickyFooter'
import {useBuildFailureMessage} from '../../../hooks/useBuildFailureMessage'
import {useMidnightAssets} from '../../../hooks/useMidnightAssets'
import {useMidnightDust} from '../../../hooks/useMidnightDust'
import {useMidnightUnshieldedAddress} from '../../../hooks/useMidnightUnshieldedAddress'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useConfig, useFormat, useI18n, usePnyxSession, useWalletList} from '../../../providers'
import {describeBuildFailure} from '../../../services/midnight/build-failure'

import {buildMidnightTransfer} from '../../../services/midnight/build-transfer'
import {
  readMidnightDappTicketOfKind,
  rejectMidnightDappTicket,
  settleMidnightDappTicket,
} from '../../../services/midnight/dapp-tickets'
import {runMidnight} from '../../../services/midnight/effect-boundary'
import {DEFAULT_FEE_MODE, decideFeePayer} from '../../../services/midnight/fee-payer'
import {midnightFundsNetwork} from '../../../services/midnight/networks'
import {submitBuiltTransfer} from '../../../services/midnight/send'
import {buildSelfFundedSend, submitSelfFundedSend} from '../../../services/midnight/send-self-funded'
import {parseMidnightAssetId} from '../../../services/midnight/wallet/midnight-asset-id'
import {midnightTokenDecimals, midnightTokenLabel} from '../../../services/midnight/wallet/midnight-portfolio'
import {recordPendingSend} from '../../../services/midnight/wallet/pending-send-store'
import {saveShieldedState} from '../../../services/midnight/wallet/state-store'
import {NIGHT_TOKEN_TYPE} from '../../../services/midnight/wallet/unshielded-utxo-set'
import {truncateCompact} from '../../../utils/truncate'
import {DEFAULT_DONE_HREF} from '../../cardano/review-handoff'

const ORIGIN = 'MidnightReviewScreen'

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {paddingHorizontal: spacing.spacing16, paddingBottom: spacing.spacing16, gap: spacing.spacing16},
  card: {padding: spacing.spacing16, gap: spacing.spacing8},
  warnings: {gap: spacing.spacing8},
  muted: {color: colors.textAlternative},
}))

/** What the CTA is doing. Distinct states because proving is a wait the user must understand. */
type SendPhase =
  | {readonly kind: 'idle'}
  | {readonly kind: 'proving'}
  | {readonly kind: 'submitting'}
  | {readonly kind: 'failed'; readonly message: string}

export const MidnightReviewScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const {showToast} = useToast()
  const {network} = useConfig()
  const format = useFormat()
  const {session} = usePnyxSession()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {
    to: toParam,
    rail: railParam,
    amount: amountParam,
    tokenType: tokenTypeParam,
    dapp: dappTicketId,
  } = useLocalSearchParams<{to?: string; rail?: string; amount?: string; tokenType?: string; dapp?: string}>()
  const [phase, setPhase] = useState<SendPhase>({kind: 'idle'})

  /**
   * A pending `makeTransfer` from a page, when this screen was opened for one.
   *
   * Read on every render rather than claimed once: the ticket *is* the request, and claiming it would
   * leave the second render with nothing to show. It is consumed on settle or refusal instead.
   */
  const ticket = readMidnightDappTicketOfKind(dappTicketId, 'transfer')
  /**
   * The wallet this review is about.
   *
   * ⚠️ **The ticket's, when there is one.** A request may name a wallet that is not the one the app is
   * showing — an agent can be granted several — and Midnight's per-wallet state is keyed by (group,
   * account), so building or persisting against the selection would write a shielded-coin or DUST state
   * under the wrong wallet. Silent, and close to unrecoverable.
   */
  const forWallet =
    ticket !== undefined
      ? {groupId: ticket.groupId, accountIndex: ticket.accountIndex, label: ticket.walletLabel}
      : selectedWalletGroup === null || selectedWalletGroup === undefined
        ? undefined
        : {groupId: selectedWalletGroup.groupId, accountIndex: selectedAccountIndex, label: selectedWalletGroup.name}
  // The ticket outranks the route params — a dApp's request travels in memory, not through the URL,
  // so nothing a page controls can be re-pointed at a different recipient by editing a link.
  const to = ticket?.recipient ?? toParam
  const rail = ticket?.rail ?? railParam
  /**
   * Which token this transfer moves.
   *
   * ⚠️ **Never assumed to be NIGHT.** It was, at every site in this screen, and on the shielded rail
   * that is an impossibility rather than a limitation: NIGHT has no shielded form, so the selector was
   * asked for a colour that cannot exist and answered "holds 0 of this token". The amount step and the
   * dApp ticket both name one; a route carrying something that is not hex is refused rather than
   * silently read as NIGHT, which would send the wrong asset.
   */
  const tokenType = useMemo<string | null>(() => {
    if (ticket !== undefined) return ticket.tokenType
    if (tokenTypeParam === undefined) return NIGHT_TOKEN_TYPE
    const lowered = tokenTypeParam.toLowerCase()
    if (!/^[0-9a-f]+$/.test(lowered)) {
      logger.warn('route token parameter is not hex; refusing to guess which token this sends', {
        origin: ORIGIN,
        tokenType: tokenTypeParam,
      })
      return null
    }
    return lowered
  }, [ticket, tokenTypeParam])
  const dust = useMidnightDust()

  /**
   * Who pays this send's fee, decided once so the review and the send cannot disagree.
   *
   * Shielded is always the sponsor: the self-funding builder takes unshielded inputs and has no
   * shielded form, so offering it would promise something no rail can do.
   *
   * The fee is deliberately unpriced here (`estimatedFee: null`) — a self-funded fee is only known
   * after the transaction is built, because the dust action that pays it changes the size that sets
   * it. `prefer-self` treats that as "try", and the build refuses before anything is sent if the DUST
   * turns out short.
   *
   * ⚠️ The block time is passed because it is what the *build* refuses on. Deciding without it made
   * the review say "From your DUST" and the send then spend a biometric prompt, an unshielded sync and
   * an artifact fetch before falling back to the sponsor — see `docs/DUST_SPEND_PROOF.md`.
   */
  const feeDecision = useMemo(
    () =>
      rail === 'shielded'
        ? ({kind: 'pay', payer: {by: 'sponsor'}} as const)
        : decideFeePayer(DEFAULT_FEE_MODE, {
            balance: dust.balance,
            staleness: dust.staleness,
            estimatedFee: null,
            blockTimeSecs: dust.blockTimeSecs,
          }),
    [rail, dust.balance, dust.staleness, dust.blockTimeSecs],
  )
  /** What the review shows. A refusal cannot happen under `prefer-self`; `send` handles it if it ever can. */
  const feePayer = feeDecision.kind === 'pay' ? feeDecision.payer : ({by: 'sponsor'} as const)

  const ourNetwork = midnightFundsNetwork(network)
  const ourAddress = useMidnightUnshieldedAddress()
  const {assets} = useMidnightAssets()

  /**
   * What this rail holds of the token being sent, or `null` where it cannot say.
   *
   * The same read the amount step makes, for the same reason: null is "not synced", not "empty", and
   * the review must not turn a missing figure into a claim about the wallet.
   */
  const available = useMemo<bigint | null>(() => {
    if (tokenType === null) return null
    const want = rail === 'shielded' ? 'shielded' : 'unshielded'
    const holding = assets.find((asset) => {
      const ref = parseMidnightAssetId(asset.id)
      return ref?.rail === want && ref.tokenType === tokenType
    })
    return holding?.quantity ?? null
  }, [assets, rail, tokenType])

  const amount = useMemo(() => {
    if (ticket !== undefined) return ticket.amount
    try {
      return amountParam === undefined ? 0n : BigInt(amountParam)
    } catch (e: unknown) {
      // A route param is not a trusted number. Zero is refused below rather than sent — but a
      // malformed amount and an absent one then produce the same refusal.
      logger.warn('Route amount parameter is not a number; treating it as zero', {
        origin: 'MidnightReviewScreen',
        error: String(e),
      })
      return 0n
    }
  }, [amountParam, ticket])

  const view = useMemo<MidnightConfirmView | null>(() => {
    if (to === undefined || ourNetwork === null || amount <= 0n || tokenType === null) return null
    const parsed = parseMidnightAddress(to)
    if (!parsed.ok) return null
    return reviewMidnightTransfer({
      rail: rail === 'shielded' ? 'shielded' : 'unshielded',
      network: ourNetwork,
      tokenType,
      recipient: to,
      recipientNetwork: parsed.network,
      amount,
      /**
       * Our own addresses, so a self-send is recognised. The unshielded one is what we can state:
       * there is no accessor for our shielded address yet, so a *shielded* self-send still goes
       * unwarned — a real gap, and a smaller one than claiming we checked.
       */
      ourAddresses: ourAddress === undefined ? [] : [ourAddress],
      /**
       * Selection happens inside the send, against a UTxO set this screen does not fetch, so there
       * is nothing here to derive a change figure from. `selected: amount` says "exactly covered",
       * which is why `change` comes out `0n` — no consumer renders it today.
       */
      selected: amount,
      inputCount: 0,
      // The real balance, or null where the rail cannot report one. It used to be `amount`, which
      // made `amount >= balance` true on every send and the whole-balance warning permanent.
      balance: available,
      fee: feePayer,
      ttlSecs: Math.floor(Date.now() / 1000) + 3600,
    })
  }, [to, rail, amount, tokenType, ourNetwork, ourAddress, available, feePayer])

  /**
   * What the user actually reviewed, held still once they have decided.
   *
   * ⚠️ **Otherwise this send's own locks make it warn about itself.** `available` comes from
   * `useMidnightUnshieldedBalance`, whose totals are the *spendable* set — `confirmed − locked`. The
   * moment Send is pressed the inputs are locked and the feed republishes, so the balance drops by the
   * amount being sent, `amount >= balance` turns true, and a "spends your entire balance" callout
   * appears **after** the decision it was meant to inform. Observed on device: 5 spendable outputs
   * became 2 between confirming and navigating. The screen already carries a note about an earlier,
   * permanent version of the same bug.
   *
   * Held rather than hidden: the point is that nothing new appears, not that what they agreed to
   * disappears while it is being proved.
   */
  const reviewedRef = useRef<MidnightConfirmView | null>(null)
  if (phase.kind === 'idle') reviewedRef.current = view

  /**
   * Answer a caller that asked us to send, once the bytes are away.
   *
   * ⚠️ Back, not `dismissTo`: the caller may be a page in the WebView this stack owns, and unwinding
   * would unmount it at the moment it gets its answer.
   */
  // ⚠️ The reader's sentence, never the diagnostic. `describeBuildFailure` still goes to the log.
  const failureMessage = useBuildFailureMessage()

  const finishForCaller = useCallback(
    (txHex: string): boolean => {
      if (ticket === undefined || dappTicketId === undefined || !ticket.submitAfterApproval) return false
      settleMidnightDappTicket(dappTicketId, txHex)
      router.back()
      return true
    },
    [ticket, dappTicketId, router],
  )

  const send = useCallback(async () => {
    const groupId = forWallet?.groupId
    const accountIndex = forWallet?.accountIndex
    const token = session?.token
    if (view === null || groupId === undefined || accountIndex === undefined || ourNetwork === null || to === undefined)
      return

    // A caller asked for the *bytes*, so this builds and answers it. Nothing is submitted and no pending
    // row is recorded: there is nothing in flight until they submit it, which they may never do.
    //
    // ⚠️ A caller that asked us to **send** falls through instead, into the same path the user's own send
    // takes — fee decision, submit, pending row and all. Wiring a second submit in here would make an
    // agent's send always sponsored while the user's own could pay its own fee.
    if (ticket !== undefined && dappTicketId !== undefined && !ticket.submitAfterApproval) {
      setPhase({kind: view.needsProving ? 'proving' : 'submitting'})
      try {
        const built = await buildMidnightTransfer({
          groupId,
          accountIndex: accountIndex,
          rail: view.rail,
          recipient: to,
          tokenType: view.tokenType,
          amount: view.amount,
          networkId: ourNetwork,
          biometricPrompt: t('common.biometricPrompt'),
        })
        // ⚠️ Persist before answering. The shielded builder marks its coins pending, and dropping that
        // state would let the next transfer select the same notes — which the ledger rejects. It is due
        // even though nothing was sent.
        if (built.state !== undefined) {
          await runMidnight(saveShieldedState(groupId, accountIndex, built.state, ourNetwork))
        }
        settleMidnightDappTicket(dappTicketId, hex.encode(built.transaction))
        logger.info('a dApp transfer was built and handed back', {
          origin: ORIGIN,
          dapp: ticket.origin,
          rail: view.rail,
          bytes: built.transaction.length,
          identifiers: built.identifiers,
        })
        showToast({variant: 'info', message: t('midnightReview.dappBuilt')})
        // ⚠️ Back to the browser, not `dismissTo` the wallet home. Unwinding the stack unmounts the
        // WebView — which is the page that asked for this and is now holding the answer — so the site
        // the user was on disappears at the moment it gets what it wanted.
        router.back()
      } catch (error) {
        const message = describeBuildFailure(error)
        logger.warn('a dApp transfer could not be built', {origin: ORIGIN, dapp: ticket.origin, error: message})
        // ⚠️ Two audiences, two strings. The **page** gets the diagnostic — it is a developer reading a
        // rejection — while the **user** gets a sentence in their own language. Handing the page a
        // translated sentence would make it undebuggable, and handing the user the diagnostic is what
        // put `not-ready: …` on screen.
        rejectMidnightDappTicket(dappTicketId, message)
        setPhase({kind: 'failed', message: failureMessage(error, view?.rail ?? 'unshielded')})
      }
      return
    }

    if (feeDecision.kind === 'refuse') {
      // Only reachable if the mode becomes a setting and someone picks `self`. Saying why beats a
      // silent sponsor substitution — that is the whole distinction the mode encodes.
      logger.warn('midnight send blocked: this wallet cannot pay its own fee', {
        origin: ORIGIN,
        rail: view.rail,
        reason: feeDecision.reason,
      })
      setPhase({kind: 'failed', message: feeDecision.reason})
      return
    }

    if (feeDecision.kind === 'pay' && feeDecision.substitutedBecause !== undefined) {
      // The mode asked this wallet to pay for itself and it cannot, so the sponsor is standing in. The
      // review already says "Paid for you"; without this the *reason* it changed existed nowhere.
      logger.info('the sponsor is paying this fee because the wallet cannot', {
        origin: ORIGIN,
        rail: view.rail,
        reason: feeDecision.substitutedBecause,
      })
    }

    // Self-funding needs no session: nobody is being asked to pay for us. Requiring one would block
    // the very sends that do not need the sponsor at all.
    if (feeDecision.payer.by === 'self') {
      setPhase({kind: 'proving'})
      let selfBuilt: Awaited<ReturnType<typeof buildSelfFundedSend>> | undefined
      try {
        selfBuilt = await buildSelfFundedSend({
          groupId,
          accountIndex: accountIndex,
          recipient: to,
          tokenType: view.tokenType,
          amount: view.amount,
          networkId: ourNetwork,
          biometricPrompt: t('common.biometricPrompt'),
        })
      } catch (error) {
        const message = describeBuildFailure(error)
        // Nothing has been sent, so falling back is safe here and only here.
        logger.warn('could not pay this send’s own fee; falling back to the sponsor', {
          origin: ORIGIN,
          rail: view.rail,
          error: message,
        })
      }

      if (selfBuilt !== undefined) {
        setPhase({kind: 'submitting'})
        // ⚠️ **`exit`, not `either`.** `Effect.either` recovers the typed channel only, so a *defect* —
        // anything untyped thrown below the surface — rejects `runPromise` instead. This handler sits
        // under `onPress={() => void send()}`, which discards a rejection: the money would be on the
        // node, the screen frozen on "submitting" for ever, and nothing written or logged. The plain
        // `try`/`catch` this replaced caught that; recovering only the typed half lost it.
        const submitted = await Effect.runPromise(
          Effect.exit(
            submitSelfFundedSend({
              groupId,
              accountIndex: accountIndex,
              networkId: ourNetwork,
              built: selfBuilt,
            }),
          ),
        )
        if (Exit.isSuccess(submitted)) {
          const result = submitted.value
          // Guarded for the same reason: the node already has the bytes, so a throw here must not
          // escape as an unhandled rejection. A send that landed and was not recorded is a bookkeeping
          // problem the next sync repairs; a frozen screen is not.
          try {
            await recordPendingSend(groupId, accountIndex, {
              identifiers: result.identifiers,
              rail: view.rail,
              direction: view.notes.includes('sending-to-self') ? 'self' : 'sent',
              tokenType: view.tokenType,
              amount: view.amount,
              recipient: to,
              submittedAt: new Date().toISOString(),
            })
          } catch (error) {
            logger.error('a self-funded send landed but its pending row was not written', {
              origin: ORIGIN,
              rail: view.rail,
              error: String(error),
            })
          }
          // Unlike the sponsored path this one *was* submitted, by us, and the node accepted it — so
          // the copy may say so. It still stops short of "landed": acceptance is into the pool.
          showToast({variant: 'success', message: t('midnightReview.submitted')})
          if (!finishForCaller(hex.encode(selfBuilt.transaction))) router.dismissTo(DEFAULT_DONE_HREF as never)
          return
        } else {
          // A defect has no typed failure, and it is never a rejection — nothing may fall back on it.
          const failure = Cause.failureOption(submitted.cause)
          const {cause, reason} = Option.isSome(failure)
            ? failure.value
            : {cause: 'defect' as const, reason: Cause.pretty(submitted.cause)}
          // ⚠️ **Only `rejected` may fall through to the sponsor.** A rejection is definitive — the node
          // saw the bytes and refused them, so nothing is in flight. `unreachable` leaves it unknown
          // whether the transaction was taken, and falling back on one of those sends the same money
          // twice. Read off the typed cause rather than an `instanceof` on a thrown class, so the
          // decision cannot quietly stop being made when an error crosses a boundary.
          if (cause !== 'rejected') {
            logger.warn('a self-funded midnight send may or may not have been taken; not falling back', {
              origin: ORIGIN,
              rail: view.rail,
              cause,
              error: reason,
            })
            setPhase({kind: 'failed', message: reason})
            return
          }
          logger.warn('the node refused a self-funded midnight send; falling back to the sponsor', {
            origin: ORIGIN,
            rail: view.rail,
            cause,
            error: reason,
          })
        }
      }
    }

    if (token === undefined) {
      // Sponsorship pays the fee and needs an authenticated caller, so this cannot proceed — and the
      // reason has to be *said*. This branch used to put the panel's own title ("Not sent") in the
      // message slot and return without logging, which left a failed send with no explanation on
      // screen and no trace in the log. There was nothing to diagnose it from.
      logger.warn('midnight send blocked: no session to sponsor it', {origin: ORIGIN, rail: view.rail})
      setPhase({kind: 'failed', message: t('midnightReview.failedNoSession')})
      return
    }

    setPhase({kind: view.needsProving ? 'proving' : 'submitting'})
    try {
      // The same builder the dApp connector's `makeTransfer` calls, so a transfer a page asked for and
      // one this screen asked for are the same transaction.
      const built = await buildMidnightTransfer({
        groupId,
        accountIndex: accountIndex,
        rail: view.rail,
        recipient: to,
        tokenType: view.tokenType,
        amount: view.amount,
        networkId: ourNetwork,
        biometricPrompt: t('common.biometricPrompt'),
      })
      setPhase({kind: 'submitting'})
      // Wallet context so the sponsored path locks its inputs too — a send in flight must not have
      // its outputs selected again by the next one, whoever is paying the fee.
      const result = await submitBuiltTransfer(token, built, ourNetwork, {groupId, accountIndex: accountIndex})
      // Recorded *after* the hand-off, because until the sponsor accepts the bytes there is nothing
      // in flight to track. A send with no identifiers is not recorded at all — the store refuses it
      // and says so — because a row that can never match would sit pending for ever.
      await recordPendingSend(groupId, accountIndex, {
        identifiers: result.identifiers,
        rail: view.rail,
        // The same note the screen renders, so the pending row cannot disagree with the review the
        // user just read — and so a self-send is not labelled "Sent" until the chain corrects it.
        direction: view.notes.includes('sending-to-self') ? 'self' : 'sent',
        tokenType: view.tokenType,
        amount: view.amount,
        recipient: to,
        submittedAt: new Date().toISOString(),
      })

      // Cardano's send does not ask to be acknowledged: it toasts and unwinds. Matching it here
      // removes a terminal screen that existed only to be dismissed.
      //
      // ⚠️ **Not "submitted", and kept short enough to read.** All that is known here is that the
      // service accepted the bytes; it balances and submits afterwards, and the chain can still
      // reject what it sends — it did, with `Custom error: 168`, while this screen reported success.
      // There is no channel back either: the settlement report has no `transfer` case, so the outcome
      // reaches nobody (`docs/SPONSOR_HOST.md`). Until that exists this must not claim it landed.
      showToast({variant: 'info', message: t('midnightReview.handedOver')})
      if (!finishForCaller(hex.encode(built.transaction))) router.dismissTo(DEFAULT_DONE_HREF as never)
    } catch (error) {
      // Surfaced *and* logged, in different words: the log carries the cause a bug report needs, the
      // screen carries a sentence the reader can act on.
      logger.warn('midnight send failed', {origin: ORIGIN, rail: view.rail, error: describeBuildFailure(error)})
      setPhase({kind: 'failed', message: failureMessage(error, view?.rail ?? 'unshielded')})
    }
  }, [
    view,
    session?.token,
    forWallet?.groupId,
    forWallet?.accountIndex,
    ourNetwork,
    to,
    t,
    showToast,
    router,
    ticket,
    dappTicketId,
    feeDecision,
    finishForCaller,
    failureMessage,
  ])

  /**
   * Refuse a pending dApp request if this screen goes away without answering it.
   *
   * A page awaiting `makeTransfer` holds an open promise. Dismissed, backgrounded or navigated past, it
   * would wait for ever with nothing on screen to explain why — so leaving is a refusal, and the dApp
   * is told. Settling first evicts the ticket, which makes this a no-op on the happy path.
   */
  useEffect(
    () => () => {
      if (dappTicketId !== undefined) rejectMidnightDappTicket(dappTicketId, 'the review screen was dismissed')
    },
    [dappTicketId],
  )

  if (view === null) {
    return (
      <SafeAreaViewWrapper edges={['bottom']}>
        <EmptyState title={t('midnightReview.failedTitle')} description={t('midnightSend.errorAmount')} />
      </SafeAreaViewWrapper>
    )
  }

  /** See {@link reviewedRef}: what they agreed to, not what the locks left behind. */
  const reviewed = phase.kind === 'idle' ? view : (reviewedRef.current ?? view)

  // The token's own ticker and scale. A colour nothing declares decimals for is shown in atomic units
  // rather than divided by a guessed scale, which is what the portfolio row does with the same figure.
  const sending = (value: bigint) =>
    format(value, {
      preset: 'cryptoTxDetail',
      currency: midnightTokenLabel(view.tokenType),
      decimals: midnightTokenDecimals(view.tokenType) ?? 0,
    })

  const ctaLabel =
    phase.kind === 'proving'
      ? t('midnightReview.proving')
      : phase.kind === 'submitting'
        ? t('midnightReview.submitting')
        : t('midnightReview.confirm')

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          <Button
            label={ctaLabel}
            testID="midnight-review-confirm"
            isLoading={phase.kind === 'proving' || phase.kind === 'submitting'}
            isDisabled={phase.kind === 'proving' || phase.kind === 'submitting'}
            onPress={() => void send()}
          />
        </StickyFooter>
      }
    >
      {ticket === undefined ? null : (
        <Callout
          variant="info"
          message={
            // The notice has to match what approving does, or it is a lie on the submitting path.
            ticket.submitAfterApproval
              ? t('midnightReview.dappRequestAndSend', {origin: ticket.origin})
              : t('midnightReview.dappRequest', {origin: ticket.origin})
          }
        />
      )}

      <Card style={styles.card}>
        <DataRow label={t('midnightReview.sending')} value={sending(view.amount)} size="md" />
        {forWallet === undefined ? null : (
          <DataRow label={t('midnightReview.fromWallet')} value={forWallet.label} testID="midnight-review-wallet" />
        )}
        <DataRow label={t('midnightReview.to')} value={truncateCompact(view.recipient)} />
        <DataRow
          label={t('midnightReview.rail')}
          value={view.rail === 'shielded' ? t('receive.midnightShielded') : t('receive.midnightUnshielded')}
        />
        <DataRow
          label={t('midnightReview.fee')}
          value={view.fee.by === 'sponsor' ? t('midnightReview.feeSponsored') : t('midnightReview.feeSelf')}
        />
        <DataRow label={t('midnightTx.network')} value={view.network} />
      </Card>

      {reviewed.warnings.length === 0 && reviewed.notes.length === 0 ? null : (
        <View style={styles.warnings}>
          {reviewed.warnings.map((warning) => (
            <Callout
              key={warning}
              variant="warning"
              message={t(
                (
                  {
                    'recipient-on-another-network': 'midnightReview.warningAnotherNetwork',
                    'spends-entire-balance': 'midnightReview.warningWholeBalance',
                  } as const
                )[warning],
              )}
            />
          ))}
          {/* Notes are neutral facts and are rendered as such — the model decides which is which,
              so this cannot drift into showing ordinary use in the warning colour. */}
          {reviewed.notes.map((note) => (
            <Callout
              key={note}
              variant="info"
              message={t(({'sending-to-self': 'midnightReview.noteSelfSend'} as const)[note])}
            />
          ))}
        </View>
      )}

      {view.needsProving ? <Callout variant="info" message={t('midnightReview.provingNotice')} /> : null}

      {phase.kind === 'failed' ? <Callout variant="error" message={phase.message} /> : null}
    </SafeAreaViewWrapper>
  )
}

/** Our own unshielded address, for reading the UTxOs a transfer spends. */
