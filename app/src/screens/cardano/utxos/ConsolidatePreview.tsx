/**
 * The Combine confirmation: what the planned fold will actually do.
 *
 * Every number here comes from transactions that have already been built, so it
 * is a preview rather than an estimate — and every partial outcome is stated,
 * because a fold that quietly left UTxOs behind would read as a completed one.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Modal} from '../../../components/Modal'
import {Typography} from '../../../components/Typography'
import {useNetworkCapabilities} from '../../../hooks/useNetworkCapabilities'
import {useFormat, useI18n} from '../../../providers'
import type {ConsolidationOutcome} from '../../../services/cardano/consolidation'

const ADA_DECIMALS = 6

export type ConsolidatePreviewProps = {
  readonly outcome: ConsolidationOutcome | null
  readonly onConfirm: () => void
  readonly onDismiss: () => void
}

export const ConsolidatePreview = ({outcome, onConfirm, onDismiss}: ConsolidatePreviewProps) => {
  const {t} = useI18n()
  const format = useFormat()
  const {adaTicker} = useNetworkCapabilities()

  if (outcome === null) return null

  const ada = (lovelace: bigint) =>
    format(lovelace, {preset: 'cryptoTxDetail', currency: adaTicker, decimals: ADA_DECIMALS})

  const excludedFor = (reason: ConsolidationOutcome['excluded'][number]['reason']) =>
    outcome.excluded.filter((e) => e.reason === reason).length
  const reserved = excludedFor('reserved-pure-ada')
  const overCap = excludedFor('over-input-cap')
  const notSpendable = excludedFor('not-spendable')
  // A single leftover after a *complete* fold is arithmetic, not a limitation:
  // one UTxO has nothing to combine with. Only a real stop is worth a warning.
  const leftOverKey =
    outcome.stop === 'leg-cap' ? 'leftOutLegCap' : outcome.stop === 'no-reduction' ? 'leftOutNoReduction' : null

  return (
    <Modal
      visible
      onClose={onDismiss}
      position="bottom"
      title={t('consolidate.previewTitle')}
      actions={[
        {label: t('common.buttons.cancel'), variant: 'secondary', onPress: onDismiss},
        {label: t('consolidate.confirm'), variant: 'primary', onPress: onConfirm},
      ]}
      testID="consolidate-preview"
    >
      <View style={styles.body}>
        <Typography variant="bodyLg_medium">
          {t('consolidate.result', {before: outcome.utxosBefore, after: outcome.utxosAfter})}
        </Typography>
        <Typography variant="bodyMd_regular" style={styles.muted}>
          {t('consolidate.transactions', {count: outcome.legs.length})}
        </Typography>

        <View style={styles.feeRow}>
          <Typography variant="bodyMd_regular">{t('consolidate.fee')}</Typography>
          <Typography variant="bodyMd_medium">{ada(outcome.totalFee)}</Typography>
        </View>
        {outcome.legs.length > 1 ? (
          <Typography variant="bodySm_regular" style={styles.muted}>
            {t('consolidate.feeNote')}
          </Typography>
        ) : null}

        {outcome.withdrawnRewards > 0n ? (
          <Typography variant="bodySm_regular" style={styles.muted}>
            {t('consolidate.rewardsIncluded', {amount: ada(outcome.withdrawnRewards)})}
          </Typography>
        ) : null}

        {leftOverKey !== null && outcome.remaining.length > 0 ? (
          <Typography variant="bodySm_regular" style={styles.notice}>
            {t(`consolidate.${leftOverKey}` as never, {count: outcome.remaining.length})}
          </Typography>
        ) : null}
        {notSpendable > 0 ? (
          <Typography variant="bodySm_regular" style={styles.muted}>
            {t('consolidate.notSpendable', {count: notSpendable})}
          </Typography>
        ) : null}
        {reserved > 0 ? (
          <Typography variant="bodySm_regular" style={styles.muted}>
            {t('consolidate.reservedPureAda')}
          </Typography>
        ) : null}
        {overCap > 0 ? (
          <Typography variant="bodySm_regular" style={styles.muted}>
            {t('consolidate.overInputCap', {count: overCap})}
          </Typography>
        ) : null}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  body: {gap: spacing.spacing8, paddingBottom: spacing.spacing8},
  feeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: spacing.spacing8,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefaultWeak,
  },
  muted: {color: colors.textAlternative},
  notice: {color: colors.warningDefault},
}))
