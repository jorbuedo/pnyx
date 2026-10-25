/**
 * The per-input trust panel — the visible half of the rule in `verify-request-utxos`.
 *
 * The numbers on a review of a scanned request come from the request, not from us. A verified
 * input and an unverified one must therefore never read the same; this is where that distinction
 * is drawn, before the user reaches the review funnel.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground} from '../../../components/Chamfer'
import {Tag} from '../../../components/Tag'
import {Typography} from '../../../components/Typography'
import {useI18n} from '../../../providers'
import {useFormat} from '../../../providers/NumberFormatProvider'
import type {CheckedInput} from '../../../services/keystone/verify-request-utxos'
import {truncateCompact} from '../../../utils/truncate'

export type RequestInputsProps = {
  readonly inputs: readonly CheckedInput[]
  readonly adaTicker: string
}

export const RequestInputs = ({inputs, adaTicker}: RequestInputsProps) => {
  const {t} = useI18n()
  const format = useFormat()

  return (
    <View style={styles.list} testID="airgap-inputs">
      {inputs.map((input) => {
        const verified = input.trust.kind === 'verified'
        return (
          <View key={`${input.resolved.txHashHex}:${input.resolved.index}`} style={styles.row}>
            <ChamferBackground size="auto" fillToken="backgroundLayer1" />
            <View style={styles.header}>
              <Typography variant="bodySm_medium" style={styles.outpoint}>
                {`${truncateCompact(input.resolved.txHashHex)}#${input.resolved.index}`}
              </Typography>
              <Tag
                size="sm"
                variant={verified ? 'success' : 'warning'}
                label={verified ? t('airGap.input.verified') : t('airGap.input.unverified')}
                testID={verified ? 'airgap-input-verified' : 'airgap-input-unverified'}
              />
            </View>
            {input.resolved.addressBech32 === undefined ? null : (
              <Typography variant="bodySm_regular" style={styles.address}>
                {truncateCompact(input.resolved.addressBech32)}
              </Typography>
            )}
            <Typography variant="bodyMd_medium">
              {format(input.resolved.coin, {preset: 'cryptoBalance', currency: adaTicker, decimals: 6})}
            </Typography>
            {verified ? null : (
              <Typography variant="bodySm_regular" style={styles.caveat}>
                {t('airGap.input.claimedByRequester')}
              </Typography>
            )}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing.spacing8,
  },
  row: {
    gap: theme.spacing.spacing4,
    padding: theme.spacing.spacing12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.spacing8,
  },
  outpoint: {
    color: theme.colors.textMuted,
  },
  address: {
    color: theme.colors.textAlternative,
  },
  caveat: {
    color: theme.colors.warningDefault,
  },
}))
