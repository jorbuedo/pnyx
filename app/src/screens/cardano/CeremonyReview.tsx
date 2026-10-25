/**
 * Review surface for a ceremony of several transactions: the aggregate the user
 * is actually consenting to, then each leg in submission order.
 *
 * The totals lead because that is where the confirm button is. A warning or a
 * fee that only appears on leg 2's card lets someone authorise the batch from a
 * screen that looked clean.
 *
 * @module
 */

import type {ReviewedTransaction, TransactionWarning} from '@pnyx/tx-review'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Card} from '../../components/Card'
import {Typography} from '../../components/Typography'
import {useNetworkCapabilities} from '../../hooks/useNetworkCapabilities'
import {useFormat, useI18n} from '../../providers'
import {type CeremonySummary, summarizeCeremony} from './ceremony-summary'
import {TxReview} from './review'
import {AssetLine, KeyValueRow, Section} from './review/components'
import {ReviewEnrichmentProvider} from './review/enrichment'

const ADA_DECIMALS = 6

const Totals = ({summary}: {readonly summary: CeremonySummary}) => {
  const {t} = useI18n()
  const format = useFormat()
  const {adaTicker} = useNetworkCapabilities()

  // `splitNet` returns magnitudes, not signed values, so an outflow has to be
  // re-signed before it reaches a renderer that colours by sign — otherwise a
  // send reads as a gain.
  const outflows = summary.sent.map((amount) => ({...amount, quantity: -amount.quantity}))
  const feeText = format(summary.totalFee, {preset: 'cryptoFee', currency: adaTicker, decimals: ADA_DECIMALS})

  return (
    <Card style={styles.totals}>
      <Section title={t('txReview.ceremony.summaryTitle')}>
        <KeyValueRow
          label={t('txReview.ceremony.legCount')}
          value={t('txReview.ceremony.transactionCount', {count: summary.legCount})}
        />
        {outflows.map((amount) => (
          <AssetLine key={`sent-${amount.assetId ?? 'ada'}`} amount={amount} />
        ))}
        {summary.received.map((amount) => (
          <AssetLine key={`received-${amount.assetId ?? 'ada'}`} amount={amount} />
        ))}
        {/* Already inside the net above (own outputs − own inputs), so this is
            stated for transparency, not added again. */}
        <KeyValueRow label={t('txReview.ceremony.feeIncluded')} value={feeText} />
        {summary.totalDeposit > 0n ? (
          <KeyValueRow
            label={t('txReview.ceremony.depositIncluded')}
            value={format(summary.totalDeposit, {preset: 'cryptoFee', currency: adaTicker, decimals: ADA_DECIMALS})}
          />
        ) : null}
      </Section>
    </Card>
  )
}

export const CeremonyReview = ({
  legs,
  expectedWarnings,
}: {
  readonly legs: readonly ReviewedTransaction[]
  readonly expectedWarnings?: ReadonlySet<TransactionWarning> | undefined
}) => {
  const {t} = useI18n()
  const [first, ...siblings] = legs
  if (first === undefined) return null
  const summary = summarizeCeremony(legs)

  return (
    <View style={styles.root}>
      <ReviewEnrichmentProvider reviewed={first} siblingLegs={siblings}>
        <Totals summary={summary} />
      </ReviewEnrichmentProvider>
      {legs.map((leg, index) => (
        <View key={leg.hash ?? `leg-${index}`} style={styles.leg}>
          <Typography variant="bodySm_medium" style={styles.legLabel}>
            {t('txReview.ceremony.legLabel', {index: index + 1, total: legs.length})}
          </Typography>
          <TxReview reviewed={leg} mode="confirm" expectedWarnings={expectedWarnings} />
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  root: {gap: spacing.spacing16},
  totals: {paddingHorizontal: spacing.spacing16, paddingVertical: spacing.spacing8},
  leg: {gap: spacing.spacing4},
  legLabel: {color: colors.textAlternative},
}))
