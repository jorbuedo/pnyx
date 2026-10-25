/**
 * Swap review — the swap-specific summary shown BEFORE the shared review +
 * signing ceremony (it complements it, never replaces it). Shows exactly what
 * the user reviewed at quote time: pay / receive / minimum-after-slippage,
 * route, price impact, fees, and how the swap settles (atomic vs batcher).
 *
 * "Confirm & sign" builds the tx via SteelSwap and hands it to the SAME
 * `/wallet/review-tx` ceremony that Send and dApp signing use — so the user
 * still sees the full transaction review + biometric prompt afterwards.
 *
 * @module
 */

import {useLocalSearchParams, useRouter} from 'expo-router'
import {useMemo} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons/Button'
import {Card} from '../../components/Card'
import {EmptyState} from '../../components/EmptyState'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {StickyFooter} from '../../components/StickyFooter'
import {TokenIcon} from '../../components/TokenIcon'
import {Typography} from '../../components/Typography'
import {useFormat, useI18n} from '../../providers'
import {peekSwapIntent} from './swap-intent'

const BPS = 10_000n

export const SwapReviewScreen = () => {
  const {t} = useI18n()
  const format = useFormat()
  const router = useRouter()
  const {intent: intentId} = useLocalSearchParams<{intent?: string}>()
  const intent = intentId !== undefined ? peekSwapIntent(intentId) : undefined

  const view = useMemo(() => {
    if (intent === undefined) return null
    const out = BigInt(intent.estimate.output.amount)
    const minOut = (out * (BPS - BigInt(intent.slippageBps))) / BPS
    const isAtomic = intent.estimate.split.every((leg) => leg.kind === 'mintBurn')
    const dex = intent.estimate.split[0]?.dex ?? null
    return {out, minOut, fees: intent.estimate.fees, babel: intent.estimate.babel, isAtomic, dex}
  }, [intent])

  if (intent === undefined || view === null) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.center}>
        <EmptyState icon="swap" title={t('swap.title')} description={t('swap.intentExpired')} />
      </SafeAreaViewWrapper>
    )
  }

  const {from, to} = intent
  // The tx is already built; confirming just enters the shared review + signing
  // ceremony with its ticket.
  const onConfirm = () => router.push(`/wallet/review-tx?ticket=${intent.ticketId}` as never)

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          <Button label={t('swap.confirmCta')} onPress={onConfirm} fullWidth size="xl" testID="swap-confirm" />
        </StickyFooter>
      }
    >
      <Card style={styles.pair}>
        <Leg
          label={t('swap.youPay')}
          side={from}
          amount={format(intent.amountBaseUnits, {
            preset: 'cryptoBalance',
            currency: from.label,
            decimals: from.decimals,
          })}
        />
        <View style={styles.divider} />
        <Leg
          label={t('swap.youReceive')}
          side={to}
          amount={format(view.out, {preset: 'cryptoBalance', currency: to.label, decimals: to.decimals})}
        />
      </Card>

      <Card style={styles.details}>
        <Detail
          label={t('swap.minReceived')}
          value={format(view.minOut, {preset: 'cryptoBalance', currency: to.label, decimals: to.decimals})}
        />
        <Detail label={t('swap.slippageLabel')} value={`${(intent.slippageBps / 100).toFixed(2)}%`} />
        {view.dex !== null && view.dex !== '' ? <Detail label={t('swap.routeLabel')} value={view.dex} /> : null}
        <Detail
          label={t('swap.batcherFeeLabel')}
          value={format(BigInt(view.fees.batcher.amount), {preset: 'cryptoFee', currency: 'ADA', decimals: 6})}
        />
        <Detail
          label={t('swap.depositLabel')}
          value={format(BigInt(view.fees.deposit.amount), {preset: 'cryptoFee', currency: 'ADA', decimals: 6})}
        />
        <Detail
          label={t('swap.serviceFeeLabel')}
          value={format(BigInt(view.fees.service.amount), {preset: 'cryptoFee', currency: 'ADA', decimals: 6})}
        />
        {/* Paying the SteelSwap fee in the input token rather than ADA changes
            what leaves the wallet, so it is stated before signing. */}
        {view.babel?.applied === true ? (
          <Detail label={t('swap.feesLabel')} value={t('swap.babelFeeNotice', {token: from.label})} />
        ) : null}
      </Card>

      <Typography variant="bodySm_regular" style={styles.settlement}>
        {view.isAtomic ? t('swap.settlementAtomic') : t('swap.settlementBatcher')}
      </Typography>
    </SafeAreaViewWrapper>
  )
}

const Leg = ({label, side, amount}: {label: string; side: {id: string; label: string}; amount: string}) => (
  <View style={styles.legRow}>
    <View style={styles.legLeft}>
      <TokenIcon assetId={side.id} label={side.label} size={36} />
      <View>
        <Typography variant="bodyXs_medium" style={styles.legLabel}>
          {label}
        </Typography>
        <Typography variant="bodyMd_medium">{side.label}</Typography>
      </View>
    </View>
    <Typography variant="bodyLg_semibold" numberOfLines={1} style={styles.legAmount}>
      {amount}
    </Typography>
  </View>
)

const Detail = ({label, value, danger}: {label: string; value: string; danger?: boolean}) => (
  <View style={styles.detailRow}>
    <Typography variant="bodySm_regular" style={styles.detailLabel}>
      {label}
    </Typography>
    <Typography variant="bodySm_medium" style={danger ? styles.danger : undefined}>
      {value}
    </Typography>
  </View>
)

const styles = StyleSheet.create(({spacing, colors}) => ({
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.spacing24},
  content: {padding: spacing.spacing16, gap: spacing.spacing12},
  pair: {padding: spacing.spacing16, gap: spacing.spacing12},
  legRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.spacing12},
  legLeft: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing12, flexShrink: 1},
  legLabel: {color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.7},
  legAmount: {color: colors.textDefault, flexShrink: 0},
  divider: {height: 1, backgroundColor: colors.borderDefaultWeak},
  details: {padding: spacing.spacing16, gap: spacing.spacing8},
  detailRow: {flexDirection: 'row', justifyContent: 'space-between'},
  detailLabel: {color: colors.textAlternative},
  danger: {color: colors.errorDefault},
  settlement: {color: colors.textAlternative, paddingHorizontal: spacing.spacing4},
}))
