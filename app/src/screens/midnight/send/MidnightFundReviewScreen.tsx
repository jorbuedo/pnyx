/**
 * Review and fund a transaction a dApp composed — the connector's `balanceUnsealedTransaction`.
 *
 * A sibling of {@link MidnightReviewScreen} rather than a mode of it: a funding has **no recipient and
 * no rail**, so every field that screen renders would either be missing or invented here. What the two
 * share is the ticket mechanism (`../../../services/midnight/dapp-tickets`) and the primitives below.
 *
 * **What this screen can and cannot say.** The deficit is the ledger's own figure, read from the bytes,
 * so what leaves this wallet is stated exactly. The rest of the transaction is the dApp's — its intents,
 * its contract calls, its outputs to addresses nobody here chose — and nothing on this rail renders
 * them. That gap is surfaced as a warning by the view model rather than left for the reader to notice,
 * because approving this authorises those contents too.
 *
 * Nothing is submitted. The funded bytes go back to the page, which may submit them or not.
 *
 * @module
 */

import {hex} from '@pnyx/crypto'
import type {TxDeficit} from '@pnyx/midnight-native'
import {type MidnightFundingView, reviewMidnightFunding} from '@pnyx/tx-review'
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
import {useMidnightAssets} from '../../../hooks/useMidnightAssets'
import {useMidnightDust} from '../../../hooks/useMidnightDust'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useConfig, useFormat, useI18n} from '../../../providers'
import {buildFailureApiCode, describeBuildFailure, MidnightBuildError} from '../../../services/midnight/build-failure'
import {
  readMidnightDappTicketOfKind,
  rejectMidnightDappTicket,
  settleMidnightDappTicket,
} from '../../../services/midnight/dapp-tickets'
import {runMidnight} from '../../../services/midnight/effect-boundary'
import {DEFAULT_FEE_MODE, decideFeePayer} from '../../../services/midnight/fee-payer'
import {fundDappTransaction, readTxDeficits} from '../../../services/midnight/fund-transaction'
import {midnightFundsNetwork} from '../../../services/midnight/networks'
import {payOwnFee} from '../../../services/midnight/pay-own-fee'
import {markDustSpent, savePendingDustSpend} from '../../../services/midnight/wallet/dust-state-store'
import {parseMidnightAssetId} from '../../../services/midnight/wallet/midnight-asset-id'
import {NIGHT_DISPLAY_DECIMALS} from '../../../services/midnight/wallet/midnight-portfolio'
import {NIGHT_TOKEN_TYPE} from '../../../services/midnight/wallet/unshielded-utxo-set'
import {truncateCompact} from '../../../utils/truncate'

const ORIGIN = 'MidnightFundReviewScreen'

const styles = StyleSheet.create(({spacing}) => ({
  content: {paddingHorizontal: spacing.spacing16, paddingBottom: spacing.spacing16, gap: spacing.spacing16},
  card: {padding: spacing.spacing16, gap: spacing.spacing8},
  warnings: {gap: spacing.spacing8},
}))

/**
 * What the CTA is doing.
 *
 * `paying` is its own phase because it is the only one that proves: funding adds unshielded value,
 * which has no circuit, while paying the fee from this wallet's DUST proves `midnight/dust/spend` and
 * can take a second or more on a phone.
 */
type FundPhase =
  | {readonly kind: 'reading'}
  | {readonly kind: 'idle'}
  | {readonly kind: 'funding'}
  | {readonly kind: 'paying'}
  | {readonly kind: 'failed'; readonly message: string}

export const MidnightFundReviewScreen = () => {
  const {t} = useI18n()
  // ⚠️ The reader's sentence, never the diagnostic — that keeps going to the log.
  const failureMessage = useBuildFailureMessage()
  const router = useRouter()
  const {showToast} = useToast()
  const {network} = useConfig()
  const format = useFormat()
  const {dapp: dappTicketId} = useLocalSearchParams<{dapp?: string}>()
  const [phase, setPhase] = useState<FundPhase>({kind: 'reading'})
  const [deficits, setDeficits] = useState<readonly TxDeficit[] | null>(null)

  /**
   * The pending request. Read on every render rather than claimed once: the ticket *is* the request,
   * and claiming it would leave the second render with nothing to show.
   */
  const ticket = readMidnightDappTicketOfKind(dappTicketId, 'funding')
  const ourNetwork = midnightFundsNetwork(network)
  const {assets} = useMidnightAssets()
  const dust = useMidnightDust()

  /**
   * Who pays this transaction's fee, decided once so the review and the action cannot disagree.
   *
   * This screen used to state `{by: 'sponsor'}` unconditionally, which was true only because nothing
   * else was wired. It is the same question a send asks, so it gets the same answer from the same
   * rule: `prefer-self` pays from this wallet where it can and degrades to the sponsor where it
   * cannot, naming the reason either way.
   *
   * Unpriced on purpose (`estimatedFee: null`) — a self-paid fee is only known once the transaction is
   * built, because the dust action that pays it changes the size that sets it.
   */
  const feeDecision = useMemo(
    () =>
      decideFeePayer(DEFAULT_FEE_MODE, {
        balance: dust.balance,
        staleness: dust.staleness,
        estimatedFee: null,
        blockTimeSecs: dust.blockTimeSecs,
      }),
    [dust.balance, dust.staleness, dust.blockTimeSecs],
  )
  /** What the review shows. A refusal cannot happen under `prefer-self`; the action handles it if it can. */
  const feePayer = feeDecision.kind === 'pay' ? feeDecision.payer : ({by: 'sponsor'} as const)

  /**
   * What the transaction owes, from the ledger.
   *
   * Read here rather than by the producer so no key is needed to find out: a request's cost has to be
   * on screen before anyone is asked to approve it, and the vault is only opened by the CTA.
   */
  useEffect(() => {
    const txHex = ticket?.txHex
    if (txHex === undefined) return
    let live = true
    const decoded = hex.decode(txHex)
    if (decoded._tag === 'Left') {
      // The connector already checked it is hex, so this is a wallet-side failure, not the page's.
      logger.warn('a dApp funding request did not decode', {origin: ORIGIN, dapp: ticket?.origin})
      setPhase({kind: 'failed', message: t('midnightFund.failedUnreadable')})
      return
    }
    void readTxDeficits(decoded.right)
      .then((read) => {
        if (!live) return
        setDeficits(read)
        setPhase({kind: 'idle'})
        logger.debug('a dApp funding request was read', {
          origin: ORIGIN,
          dapp: ticket?.origin,
          deficits: read.length,
        })
      })
      .catch((error: unknown) => {
        if (!live) return
        const message = describeBuildFailure(error)
        // "Could not be read" and "owes nothing" are different facts, and only one is approvable.
        logger.warn('a dApp funding request could not be read', {origin: ORIGIN, dapp: ticket?.origin, message})
        setPhase({kind: 'failed', message: failureMessage(error, 'unshielded')})
      })
    return () => {
      live = false
    }
  }, [ticket?.txHex, ticket?.origin, t, failureMessage])

  /** What the unshielded rail holds per token, so a whole-balance funding can be called out. */
  const balanceOf = useCallback(
    (tokenType: string): bigint | null => {
      const holding = assets.find((asset) => {
        const ref = parseMidnightAssetId(asset.id)
        return ref?.rail === 'unshielded' && ref.tokenType === tokenType
      })
      // `null` is "not synced", never "none" — the same rule the transfer review follows.
      return holding?.quantity ?? null
    },
    [assets],
  )

  const view = useMemo<MidnightFundingView | null>(() => {
    if (deficits === null || ticket === undefined || ourNetwork === null) return null
    return reviewMidnightFunding({
      network: ourNetwork,
      origin: ticket.origin,
      legs: deficits
        // Only what this wallet could fund appears as a leg. A shielded or DUST deficit is refused
        // natively, and it is reported below as a refusal rather than dressed up as a cost.
        .filter((deficit) => deficit.kind === 'unshielded' && deficit.tokenType !== null)
        .map((deficit) => ({
          tokenType: deficit.tokenType as string,
          segment: deficit.segment,
          owed: deficit.owed,
          balance: balanceOf(deficit.tokenType as string),
        })),
      fee: feePayer,
    })
  }, [deficits, ticket, ourNetwork, balanceOf, feePayer])

  /** A deficit this wallet cannot fund at all — said before the CTA, not after signing. */
  const unfundable = useMemo(() => (deficits ?? []).filter((deficit) => deficit.kind !== 'unshielded'), [deficits])

  const fund = useCallback(async () => {
    if (ticket === undefined || dappTicketId === undefined) return
    // ⚠️ The ticket's wallet, not the selected one: a funding request may name a wallet the app is not
    // showing, and the state this writes is keyed by (group, account).
    const {groupId, accountIndex} = ticket
    if (view === null || deficits === null || ourNetwork === null) return

    const decoded = hex.decode(ticket.txHex)
    if (decoded._tag === 'Left') {
      setPhase({kind: 'failed', message: t('midnightFund.failedUnreadable')})
      return
    }

    try {
      // ⚠️ **A transaction that owes nothing is still approvable.** A contract call that moves no value
      // has no deficit, so the native balancer refuses it — "needs at least one candidate UTxO to fund
      // a deficit with" — and nothing was ever handed back. The page then asked to submit bytes the
      // wallet had never remembered approving, and refused those too: two refusals, one cause. There is
      // simply nothing to balance here, so the transaction passes through unchanged.
      let transaction = decoded.right
      if (deficits.length > 0) {
        setPhase({kind: 'funding'})
        transaction = await fundDappTransaction({
          groupId,
          accountIndex: accountIndex,
          transaction: decoded.right,
          deficits,
          networkId: ourNetwork,
          biometricPrompt: t('common.biometricPrompt'),
        })
      }

      // Paying from this wallet **seals** the transaction, so it stops being something the sponsor can
      // bind and becomes something a node takes as-is. `runMidnightSubmit` reads which shape it got.
      let paidOurselves = false
      if (feePayer.by === 'self') {
        setPhase({kind: 'paying'})
        const paid = await payOwnFee({
          groupId,
          accountIndex: accountIndex,
          transaction,
          networkId: ourNetwork,
          biometricPrompt: t('common.biometricPrompt'),
        })
        transaction = paid.transaction
        paidOurselves = true
        // ⚠️ Recorded now rather than after submission, because this screen does not submit — the page
        // does, later, and may never. A **pending** record is the shape that survives both outcomes: it
        // carries the fee intent's own TTL and reverts on its own if the transaction is dropped, while
        // not recording it at all would let the next fee pick the same DUST output, which the ledger
        // rejects outright.
        await runMidnight(markDustSpent(groupId, accountIndex)).catch((error: unknown) => {
          logger.error('a fee was paid from this wallet but the spend was not marked; re-sync its DUST', {
            origin: ORIGIN,
            error: String(error),
          })
        })
        await runMidnight(
          savePendingDustSpend(groupId, accountIndex, {
            state: paid.dustState,
            expiresAt: paid.expiresAt,
            identifiers: paid.identifiers,
          }),
        ).catch((error: unknown) => {
          logger.error('a fee was paid from this wallet but its dust state was not recorded', {
            origin: ORIGIN,
            error: String(error),
          })
        })
      }

      settleMidnightDappTicket(dappTicketId, hex.encode(transaction))
      logger.info('a dApp transaction was approved and handed back', {
        origin: ORIGIN,
        dapp: ticket.origin,
        was: decoded.right.length,
        now: transaction.length,
        funded: deficits.length > 0,
        feePaidBy: paidOurselves ? 'self' : 'sponsor',
      })
      showToast({
        variant: 'info',
        message: deficits.length > 0 ? t('midnightFund.handedBack') : t('midnightFund.approvedAndReturned'),
      })
      // ⚠️ Back to the browser, not `dismissTo` the wallet home. Unwinding the stack unmounts the
      // WebView — the page that asked for this and is now holding the answer.
      router.back()
    } catch (error) {
      const message = describeBuildFailure(error)
      // ⚠️ The page is told *which* failure. Every refusal used to go back as `Rejected`, which means
      // the user declined — so a wallet that simply could not cover the amount reported a decision its
      // owner never made. `InsufficientFunds` is the spec's code for exactly this, and it had no
      // producer until here.
      // The kind, not the sentence: a screen picks its copy from it and the page gets the matching
      // protocol code. Anything that is not a build failure has no kind, so it stays `InternalError`.
      const apiCode =
        error instanceof MidnightBuildError ? buildFailureApiCode(error.cause) : ('InternalError' as const)
      logger.warn('a dApp transaction could not be funded', {
        origin: ORIGIN,
        dapp: ticket.origin,
        apiCode,
        error: message,
      })
      // The page hears why as well: a promise left open is a dApp that hangs with nothing on screen.
      rejectMidnightDappTicket(dappTicketId, message, apiCode)
      setPhase({kind: 'failed', message: failureMessage(error, 'unshielded')})
    }
  }, [view, deficits, ticket, dappTicketId, ourNetwork, feePayer, t, showToast, router, failureMessage])

  /**
   * Refuse a pending request if this screen goes away without answering it.
   *
   * A page awaiting `balanceUnsealedTransaction` holds an open promise. Settling first evicts the
   * ticket, which makes this a no-op on the happy path.
   */
  useEffect(
    () => () => {
      if (dappTicketId !== undefined) rejectMidnightDappTicket(dappTicketId, 'the review screen was dismissed')
    },
    [dappTicketId],
  )

  if (phase.kind === 'reading') {
    return (
      <SafeAreaViewWrapper edges={['bottom']}>
        <EmptyState title={t('midnightFund.readingTitle')} description={t('midnightFund.readingBody')} />
      </SafeAreaViewWrapper>
    )
  }

  if (view === null) {
    return (
      <SafeAreaViewWrapper edges={['bottom']}>
        <EmptyState
          title={t('midnightFund.failedTitle')}
          description={phase.kind === 'failed' ? phase.message : t('midnightFund.failedUnreadable')}
        />
      </SafeAreaViewWrapper>
    )
  }

  const amount = (value: bigint, tokenType: string) =>
    tokenType === NIGHT_TOKEN_TYPE
      ? format(value, {preset: 'cryptoTxDetail', currency: 'NIGHT', decimals: NIGHT_DISPLAY_DECIMALS})
      : `${value.toString()} ${truncateCompact(tokenType)}`

  const nothingOwed = view.legs.length === 0

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          <Button
            label={
              phase.kind === 'funding'
                ? t('midnightFund.funding')
                : phase.kind === 'paying'
                  ? t('midnightFund.paying')
                  : // "Fund" would name an action that does not happen when nothing is owed.
                    nothingOwed
                    ? t('midnightFund.confirmNothingOwed')
                    : t('midnightFund.confirm')
            }
            testID="midnight-fund-confirm"
            isLoading={phase.kind === 'funding' || phase.kind === 'paying'}
            // Refusing to enable the CTA is the honest answer to a deficit we cannot cover: the page
            // is told why on dismissal, and the user is not invited to approve something that fails.
            // Both refusals are the model's, not this screen's — see `MidnightFundingWarning`.
            //
            // ⚠️ `failed` is in the list because it was not, and the button stayed live under the red
            // error — inviting a second attempt at a request the page had already been told was
            // rejected, whose ticket is gone. Pressing it did nothing at all.
            isDisabled={
              phase.kind === 'funding' ||
              phase.kind === 'paying' ||
              phase.kind === 'failed' ||
              unfundable.length > 0 ||
              view.warnings.includes('cannot-cover')
            }
            onPress={() => void fund()}
          />
        </StickyFooter>
      }
    >
      <Callout
        variant="info"
        message={
          nothingOwed
            ? t('midnightFund.dappRequestNothingOwed', {origin: view.origin})
            : t('midnightFund.dappRequest', {origin: view.origin})
        }
      />

      <Card style={styles.card}>
        {nothingOwed ? (
          <DataRow label={t('midnightFund.owed')} value={t('midnightFund.owedNothing')} size="md" />
        ) : (
          [...view.totalByToken.entries()].map(([tokenType, total]) => (
            <DataRow key={tokenType} label={t('midnightFund.owed')} value={amount(total, tokenType)} size="md" />
          ))
        )}
        <DataRow
          label={t('midnightReview.fee')}
          value={view.fee.by === 'sponsor' ? t('midnightReview.feeSponsored') : t('midnightReview.feeSelf')}
        />
        <DataRow label={t('midnightTx.network')} value={view.network} />
      </Card>

      <View style={styles.warnings}>
        {view.warnings.map((warning) => (
          <Callout
            key={warning}
            // `cannot-cover` is not a hazard to weigh, it is a refusal — the CTA is off and nothing
            // will happen, so it is rendered as such rather than in the warning colour.
            variant={warning === 'cannot-cover' ? 'error' : 'warning'}
            message={t(
              (
                {
                  'contents-not-described': 'midnightFund.warningContents',
                  'funds-entire-balance': 'midnightFund.warningWholeBalance',
                  'cannot-cover': 'midnightFund.cannotCover',
                } as const
              )[warning],
            )}
          />
        ))}
        {unfundable.map((deficit) => (
          <Callout
            key={`${deficit.kind}-${deficit.segment}`}
            variant="error"
            message={t('midnightFund.unfundableKind', {kind: deficit.kind})}
          />
        ))}
      </View>

      {phase.kind === 'failed' ? <Callout variant="error" message={phase.message} /> : null}
    </SafeAreaViewWrapper>
  )
}
