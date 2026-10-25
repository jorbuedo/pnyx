/**
 * Review a Midnight transaction that already exists, from its own bytes.
 *
 * The third Midnight review, and the one the other two are not. `MidnightReviewScreen` and
 * `MidnightFundReviewScreen` render a *request* — a recipient and an amount someone asked for — because
 * at that point there is no transaction. This screen is handed the transaction, so every figure on it
 * is read from the transaction: `txFactsJson` (native) → `parseMidnightTxFactsJson` →
 * `midnightTxEffect` → `reviewMidnightTransaction`. `docs/MIDNIGHT_REVIEW_FROM_BYTES.md` has the
 * argument for turning the order round.
 *
 * ⚠️ **It is the approval boundary for co-funding.** A co-funded transaction arrives already signed by
 * several wallets, and `submitTransaction` deliberately raises no review — so without this screen a
 * builder would move several wallets' funds with nobody having seen it. What it has to answer, and
 * what the request-shaped screens cannot, is *whose money is whose*: the offer names an owner per
 * input, and the ticket names which of those owners are wallets on this device.
 *
 * ⚠️ **Nothing is built here.** The bytes exist, so approving either submits them or hands them back;
 * a failure has therefore not half-built anything.
 *
 * @module
 */

import {hex} from '@pnyx/crypto'
import {provenTxIdentifiers, txFactsJson} from '@pnyx/midnight-native'
import {
  type MidnightEffectGap,
  type MidnightTransactionView,
  type MidnightTxParty,
  midnightTxEffect,
  readMidnightTxFactsJson,
  reviewMidnightTransaction,
} from '@pnyx/tx-review'
import {useLocalSearchParams, useRouter} from 'expo-router'
import {useCallback, useEffect, useMemo, useState} from 'react'
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
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useConfig, useFormat, useI18n, usePnyxSession} from '../../../providers'
import {describeBuildFailure} from '../../../services/midnight/build-failure'
import {
  readMidnightDappTicketOfKind,
  rejectMidnightDappTicket,
  settleMidnightDappTicket,
} from '../../../services/midnight/dapp-tickets'
import {midnightFundsNetwork} from '../../../services/midnight/networks'
import {midnightAddressOfOwner, midnightOwnerPayload} from '../../../services/midnight/owner-payload'
import {NIGHT_DISPLAY_DECIMALS} from '../../../services/midnight/wallet/midnight-portfolio'
import {recordPendingSend} from '../../../services/midnight/wallet/pending-send-store'
import {NIGHT_TOKEN_TYPE} from '../../../services/midnight/wallet/unshielded-utxo-set'
import {submitSponsoredTransfer} from '../../../services/pnyx-proving'
import {truncateCompact} from '../../../utils/truncate'
import {DEFAULT_DONE_HREF} from '../../cardano/review-handoff'

const ORIGIN = 'MidnightTxReviewScreen'

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {paddingHorizontal: spacing.spacing16, paddingBottom: spacing.spacing16, gap: spacing.spacing16},
  card: {padding: spacing.spacing16, gap: spacing.spacing8},
  notices: {gap: spacing.spacing8},
  muted: {color: colors.textAlternative},
}))

/**
 * What the CTA is doing.
 *
 * No proving state: the transaction arrives proven. `reading` is the native read, which happens before
 * anyone is asked to approve anything — a screen that showed nothing until after the decision would be
 * asking for approval of an unnamed transaction.
 */
type ApprovePhase =
  | {readonly kind: 'reading'}
  | {readonly kind: 'idle'}
  | {readonly kind: 'submitting'}
  | {readonly kind: 'failed'; readonly message: string}

export const MidnightTxReviewScreen = () => {
  const {t} = useI18n()
  // ⚠️ The reader's sentence, never the diagnostic — that keeps going to the log.
  const failureMessage = useBuildFailureMessage()
  const router = useRouter()
  const {showToast} = useToast()
  const {network} = useConfig()
  const format = useFormat()
  const {session} = usePnyxSession()
  const {dapp: dappTicketId} = useLocalSearchParams<{dapp?: string}>()
  const [phase, setPhase] = useState<ApprovePhase>({kind: 'reading'})
  const [factsJson, setFactsJson] = useState<string | null>(null)

  /**
   * The pending request. Read on every render rather than claimed once: the ticket *is* the request,
   * and claiming it would leave the second render with nothing to show.
   */
  const ticket = readMidnightDappTicketOfKind(dappTicketId, 'transaction')
  const ourNetwork = midnightFundsNetwork(network)
  /**
   * A party's address as a person can check it: the `mn_addr…` when it encodes, the raw owner when it
   * does not. Never a plausible-looking address for a payload that is not one.
   */
  const partyAddressLabel = (owner: string): string =>
    (ourNetwork === null ? null : midnightAddressOfOwner(owner, ourNetwork)) ?? owner

  /**
   * Which of this device's wallets owns which address.
   *
   * ⚠️ An address that will not parse is **dropped and logged**, not skipped silently: it would make
   * that wallet's own contribution read as a stranger's payment, which is the one thing this screen
   * exists to get right.
   */
  const ourNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const wallet of ticket?.ourWallets ?? []) {
      const payload = midnightOwnerPayload(wallet.address)
      if (payload === null) {
        logger.warn('a wallet named for a transaction review has no readable unshielded address', {
          origin: ORIGIN,
          wallet: wallet.name,
        })
        continue
      }
      names.set(payload, wallet.name)
    }
    return names
  }, [ticket?.ourWallets])

  /**
   * What the transaction contains, read natively.
   *
   * Read here rather than by the producer so no key is needed to find out, and so the figures on
   * screen and the bytes being approved are the same object.
   */
  useEffect(() => {
    const txHex = ticket?.txHex
    if (txHex === undefined) return
    let live = true
    const decoded = hex.decode(txHex)
    if (decoded._tag === 'Left') {
      // The producer built these bytes, so this is a wallet-side failure rather than a caller's.
      logger.warn('a transaction handed to the review did not decode', {origin: ORIGIN, dapp: ticket?.origin})
      setPhase({kind: 'failed', message: t('midnightTxReview.failedUnreadable')})
      return
    }
    void txFactsJson(decoded.right)
      .then((json) => {
        if (!live) return
        setFactsJson(json)
        setPhase({kind: 'idle'})
        logger.debug('a transaction was read for review', {
          origin: ORIGIN,
          dapp: ticket?.origin,
          bytes: decoded.right.length,
        })
      })
      .catch((error: unknown) => {
        if (!live) return
        const message = describeBuildFailure(error)
        // "Could not be read" and "does nothing" are different facts, and only one is approvable.
        logger.warn('a transaction could not be read for review', {
          origin: ORIGIN,
          dapp: ticket?.origin,
          error: message,
        })
        setPhase({kind: 'failed', message: failureMessage(error, 'unshielded')})
      })
    return () => {
      live = false
    }
  }, [ticket?.txHex, ticket?.origin, t, failureMessage])

  const view = useMemo<MidnightTransactionView | null>(() => {
    if (factsJson === null || ticket === undefined || ourNetwork === null) return null
    const {facts, unreadable} = readMidnightTxFactsJson(factsJson)
    if (unreadable !== null) {
      // ⚠️ Not the same as `understood: false`, which the screen already renders. This is the native
      // reader and the parser disagreeing about a shape — a drift with nothing else to notice it, and
      // the screen shows the user "incomplete" either way.
      logger.error('the native transaction reader’s answer could not be read', {
        origin: ORIGIN,
        dapp: ticket.origin,
        reason: unreadable,
      })
    }
    return reviewMidnightTransaction({
      network: ourNetwork,
      origin: ticket.origin,
      facts,
      /**
       * ⚠️ No `shielded` half. Opening our own shielded outputs needs the Zswap key, and this screen
       * holds none — so a shielded offer is reported as a gap rather than decrypted. That is the
       * honest answer, and the effect says so instead of totalling what it cannot see.
       */
      effect: midnightTxEffect({facts, ourAddresses: [...ourNames.keys()]}),
      ourNames,
      // The transaction leaves here unbound, so the fee is the sponsor's — the same statement every
      // device-built Midnight transaction makes.
      fee: {by: 'sponsor'},
      nowSecs: Math.floor(Date.now() / 1000),
    })
  }, [factsJson, ticket, ourNetwork, ourNames])

  const approve = useCallback(async () => {
    if (ticket === undefined || dappTicketId === undefined || view === null) return
    const decoded = hex.decode(ticket.txHex)
    if (decoded._tag === 'Left') {
      setPhase({kind: 'failed', message: t('midnightTxReview.failedUnreadable')})
      return
    }

    // A caller that wants the bytes gets them and nothing is sent: there is nothing in flight until
    // they submit it, which they may never do.
    if (!ticket.submitAfterApproval) {
      settleMidnightDappTicket(dappTicketId, ticket.txHex)
      logger.info('a reviewed transaction was approved and handed back', {
        origin: ORIGIN,
        dapp: ticket.origin,
        bytes: decoded.right.length,
      })
      showToast({variant: 'info', message: t('midnightTxReview.handedBack')})
      // ⚠️ Back, not `dismissTo`: the caller may be a page in the WebView this stack owns, and
      // unwinding would unmount it at the moment it gets its answer.
      router.back()
      return
    }

    const token = session?.token
    if (ourNetwork === null) {
      // Unreachable while `view` exists (it is built from the same value), and cheap to say rather than
      // assert: a send needs to name its network, and this build has no Midnight rail for the selection.
      setPhase({kind: 'failed', message: t('midnightTxReview.failedUnreadable')})
      return
    }
    if (token === undefined) {
      // The fee is paid for us, so sponsorship needs an authenticated caller — and the reason has to
      // be said rather than left as a disabled button.
      logger.warn('a reviewed transaction cannot be sent: no session to sponsor it', {
        origin: ORIGIN,
        dapp: ticket.origin,
      })
      setPhase({kind: 'failed', message: t('midnightTxReview.failedNoSession')})
      return
    }

    setPhase({kind: 'submitting'})
    try {
      // Read before the bytes leave: a device-built transaction has no hash, so the identifiers are
      // the only handle it will ever have.
      const identifiers = await provenTxIdentifiers(decoded.right)
      await submitSponsoredTransfer(token, decoded.right, ourNetwork)
      settleMidnightDappTicket(dappTicketId, ticket.txHex)
      logger.info('a reviewed transaction was approved and sent for sponsorship', {
        origin: ORIGIN,
        dapp: ticket.origin,
        bytes: decoded.right.length,
        identifiers,
      })
      /**
       * Recorded against the ticket's wallet after the hand-off, because until the sponsor accepts the
       * bytes there is nothing in flight to track.
       *
       * ⚠️ Guarded: the service already has the transaction, so a throw here must not escape as an
       * unhandled rejection. A send that landed and was not recorded is a bookkeeping problem the next
       * sync repairs; a screen frozen on "sending" is not.
       */
      try {
        const paid = view.delta.get(NIGHT_TOKEN_TYPE) ?? 0n
        await recordPendingSend(ticket.groupId, ticket.accountIndex, {
          identifiers,
          rail: 'unshielded',
          direction: view.notes.includes('entirely-between-our-wallets') ? 'self' : 'sent',
          tokenType: NIGHT_TOKEN_TYPE,
          // What left this device, as the transaction states it — a magnitude, since the row records a
          // send. `0n` where nothing of ours moved, which the review has already said out loud.
          amount: paid < 0n ? -paid : 0n,
          // The largest recipient, which is what a pending row can name from a transaction with
          // several parties. The review above is where the whole picture is.
          recipient: view.parties.find((party) => party.role === 'receives')?.address ?? '',
          submittedAt: new Date().toISOString(),
        })
      } catch (error) {
        logger.error('a reviewed transaction was sent but its pending row was not written', {
          origin: ORIGIN,
          dapp: ticket.origin,
          error: String(error),
        })
      }
      // ⚠️ Not "landed": all that is known is that the service accepted the bytes. It balances and
      // submits afterwards, and the chain can still refuse what it sends.
      showToast({variant: 'success', message: t('midnightTxReview.submitted')})
      router.dismissTo(DEFAULT_DONE_HREF as never)
    } catch (error) {
      const message = describeBuildFailure(error)
      logger.warn('a reviewed transaction could not be sent', {origin: ORIGIN, dapp: ticket.origin, error: message})
      // The caller hears why as well: a promise left open is a caller that hangs with nothing to show.
      rejectMidnightDappTicket(dappTicketId, message)
      setPhase({kind: 'failed', message: failureMessage(error, 'unshielded')})
    }
  }, [ticket, dappTicketId, view, ourNetwork, session?.token, t, showToast, router, failureMessage])

  /**
   * Refuse a pending request if this screen goes away without answering it.
   *
   * Settling first evicts the ticket, which makes this a no-op on the happy path.
   */
  useEffect(
    () => () => {
      if (dappTicketId !== undefined) rejectMidnightDappTicket(dappTicketId, 'the review screen was dismissed')
    },
    [dappTicketId],
  )

  const amount = (value: bigint, tokenType: string) =>
    tokenType === NIGHT_TOKEN_TYPE
      ? format(value, {preset: 'cryptoTxDetail', currency: 'NIGHT', decimals: NIGHT_DISPLAY_DECIMALS})
      : `${value.toString()} ${truncateCompact(tokenType)}`

  /** One party's line: what it puts in or takes out, per token, signed as the review reports it. */
  const partyAmounts = (party: MidnightTxParty) =>
    [...party.netByToken.entries()].map(([tokenType, net]) => amount(net < 0n ? -net : net, tokenType)).join(', ')

  const gapMessage = (gap: MidnightEffectGap): string => {
    switch (gap.kind) {
      case 'unreadable-transaction':
        return t('midnightTxReview.gapUnreadableTransaction')
      case 'shielded-not-ours':
        return t('midnightTxReview.gapShieldedNotOurs', {count: gap.count})
      case 'unreadable-entry':
        return t('midnightTxReview.gapUnreadableEntry', {count: gap.count})
      case 'own-addresses-unknown':
        return t('midnightTxReview.gapOwnAddressesUnknown')
    }
  }

  if (phase.kind === 'reading') {
    return (
      <SafeAreaViewWrapper edges={['bottom']}>
        <EmptyState title={t('midnightTxReview.readingTitle')} description={t('midnightTxReview.readingBody')} />
      </SafeAreaViewWrapper>
    )
  }

  if (view === null) {
    return (
      <SafeAreaViewWrapper edges={['bottom']}>
        <EmptyState
          title={t('midnightTxReview.failedTitle')}
          description={phase.kind === 'failed' ? phase.message : t('midnightTxReview.failedUnreadable')}
        />
      </SafeAreaViewWrapper>
    )
  }

  /**
   * One party's line — the direction and the figure in one string.
   *
   * ⚠️ One key per direction with the amount interpolated, rather than a label and a value
   * concatenated: a sentence assembled from two translated fragments only reads correctly in English.
   */
  const partyLine = (role: MidnightTxParty['role'], value: string) =>
    role === 'pays'
      ? t('midnightTxReview.paysAmount', {amount: value})
      : role === 'receives'
        ? t('midnightTxReview.receivesAmount', {amount: value})
        : t('midnightTxReview.bothAmount', {amount: value})

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          <Button
            label={
              phase.kind === 'submitting'
                ? t('midnightTxReview.submitting')
                : ticket?.submitAfterApproval === true
                  ? t('midnightTxReview.confirm')
                  : t('midnightTxReview.confirmHandBack')
            }
            testID="midnight-tx-review-confirm"
            isLoading={phase.kind === 'submitting'}
            /**
             * ⚠️ **An expired transaction cannot be approved, and neither can an unreadable one.**
             * Both are refusals the model can already see, so the CTA is off rather than taking
             * someone through a send to reach a failure. Every other warning is a hazard to weigh,
             * not a bar — including a partial effect, which is exactly when a person's judgement is
             * what the screen is for.
             */
            isDisabled={
              phase.kind === 'submitting' ||
              view.warnings.includes('already-expired') ||
              view.gaps.some((gap) => gap.kind === 'unreadable-transaction')
            }
            onPress={() => void approve()}
          />
        </StickyFooter>
      }
    >
      <Callout variant="info" message={t('midnightTxReview.request', {origin: view.origin})} />

      <Card style={styles.card}>
        {/* A party we do not hold is named by its address, which is the only name it has here. ⚠️ As
            the `mn_addr…`, not the raw owner: the facts report owners as 32-byte hex because that is
            how an offer names them, and a person checking "is this the address I gave the agent?" has
            only the bech32 form to compare against. Showing the payload made an agent's recipient
            unverifiable by eye. */}
        {view.parties.map((party) => (
          <DataRow
            key={party.address}
            label={party.name ?? truncateCompact(partyAddressLabel(party.address))}
            value={partyLine(party.role, partyAmounts(party))}
            size="md"
          />
        ))}
        {[...view.delta.entries()].map(([tokenType, net]) => (
          <DataRow
            key={`ours-${tokenType}`}
            label={t('midnightTxReview.yourSide')}
            value={partyLine(net < 0n ? 'pays' : 'receives', amount(net < 0n ? -net : net, tokenType))}
          />
        ))}
      </Card>

      <Card style={styles.card}>
        <DataRow
          label={t('midnightTxReview.fee')}
          value={view.fee.by === 'sponsor' ? t('midnightTxReview.feeSponsored') : t('midnightTxReview.feeSelf')}
        />
        <DataRow
          label={t('midnightTxReview.expires')}
          value={
            view.expiresAtSecs === null
              ? t('midnightTxReview.expiresUnknown')
              : new Date(view.expiresAtSecs * 1000).toLocaleString()
          }
        />
        <DataRow label={t('midnightTx.network')} value={view.transactionNetwork || view.network} />
        {view.segments > 1 ? <DataRow label={t('midnightTxReview.segments', {count: view.segments})} value="" /> : null}
        {view.shieldedOutputs > 0 ? (
          <DataRow label={t('midnightTxReview.shielded', {count: view.shieldedOutputs})} value="" />
        ) : null}
        {view.calls.map((call) => (
          <DataRow
            key={`${call.address}-${call.entryPoint}`}
            label={t('midnightTxReview.calls')}
            value={t('midnightTxReview.callRow', {
              entryPoint: call.entryPoint,
              address: truncateCompact(call.address),
            })}
          />
        ))}
        {view.deploys.map((deploy) => (
          <DataRow
            key={`deploy-${deploy.address}`}
            label={t('midnightTxReview.deploys')}
            value={truncateCompact(deploy.address)}
          />
        ))}
      </Card>

      <View style={styles.notices}>
        {view.warnings.map((warning) => (
          <Callout
            key={warning}
            // An expired transaction is not a hazard to weigh, it is a refusal — the CTA is off and
            // nothing will happen, so it is rendered as such.
            variant={warning === 'already-expired' ? 'error' : 'warning'}
            message={t(
              (
                {
                  'effect-not-understood': 'midnightTxReview.warningNotUnderstood',
                  'transaction-on-another-network': 'midnightTxReview.warningOtherNetwork',
                  'shielded-amounts-hidden': 'midnightTxReview.warningShielded',
                  'calls-not-described': 'midnightTxReview.warningCalls',
                  'unnamed-actions': 'midnightTxReview.warningUnnamedActions',
                  'nothing-of-ours-moves': 'midnightTxReview.warningNothingOfOurs',
                  'already-expired': 'midnightTxReview.warningExpired',
                } as const
              )[warning],
            )}
          />
        ))}
        {/* Which part could not be read, beside the warning that says the figures are incomplete. */}
        {view.gaps.map((gap) => (
          <Callout key={gap.kind} variant="warning" message={gapMessage(gap)} />
        ))}
        {view.notes.map((note) => (
          <Callout
            key={note}
            // Notes are facts, not hazards — see `MidnightTransactionNote`. A note in the warning
            // colour is a warning, whatever the field is called.
            variant="info"
            message={t(
              (
                {
                  'several-contributors': 'midnightTxReview.noteSeveralContributors',
                  'several-segments': 'midnightTxReview.noteSeveralSegments',
                  'entirely-between-our-wallets': 'midnightTxReview.noteBetweenOurWallets',
                } as const
              )[note],
            )}
          />
        ))}
      </View>

      {phase.kind === 'failed' ? <Callout variant="error" message={phase.message} /> : null}
    </SafeAreaViewWrapper>
  )
}
