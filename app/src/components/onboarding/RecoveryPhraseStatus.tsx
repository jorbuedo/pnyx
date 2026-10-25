/**
 * Single-line status / hint shown below the recovery-phrase grid.
 *
 * Priority (highest first): per-cell typo errors → screen-level checksum
 * error → paste-overflow notice → idle tip. Per-cell red borders flag exactly
 * which cell is wrong; this strip carries the wording.
 *
 * @module
 */

import {StyleSheet} from 'react-native-unistyles'

import {useI18n} from '../../providers'
import {Typography} from '../Typography'

export type RecoveryPhraseStatusProps = {
  cellErrors: Record<number, 'invalidWord'>
  submitError: 'invalidChecksum' | null
  pasteNotice: {pasted: number; accepted: number} | null
}

export const RecoveryPhraseStatus = ({cellErrors, submitError, pasteNotice}: RecoveryPhraseStatusProps) => {
  const {t} = useI18n()

  if (Object.keys(cellErrors).length > 0) {
    return (
      <Typography variant="bodyXs_regular" style={styles.errorText} testID="recovery-typo-error">
        {t('onboarding.recovery.invalidWord')}
      </Typography>
    )
  }
  if (submitError === 'invalidChecksum') {
    return (
      <Typography variant="bodyXs_regular" style={styles.errorText} testID="recovery-checksum-error">
        {t('onboarding.recovery.invalidChecksum')}
      </Typography>
    )
  }
  if (pasteNotice !== null) {
    return (
      <Typography variant="bodyXs_regular" style={styles.errorText} testID="recovery-paste-overflow">
        {t('onboarding.recovery.pasteOverflow', {
          pasted: pasteNotice.pasted,
          accepted: pasteNotice.accepted,
        })}
      </Typography>
    )
  }
  return (
    <Typography variant="bodyXs_regular" style={styles.tip}>
      {t('onboarding.recovery.tip')}
    </Typography>
  )
}

const styles = StyleSheet.create((theme) => ({
  tip: {
    color: theme.colors.textMuted,
  },
  errorText: {
    color: theme.colors.errorDefault,
  },
}))
