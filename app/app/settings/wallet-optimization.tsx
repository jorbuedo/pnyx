/**
 * Wallet-optimization settings — how the wallet reshapes its own UTxO set.
 *
 * The copy avoids "UTxO" on purpose: the constraint is real and the user has to
 * act on it, but they should not have to learn the ledger's vocabulary to decide
 * whether to spend a fee on it.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsGroup} from '../../src/components/SettingsGroup'
import {SettingsPickerRow} from '../../src/components/SettingsPickerRow'
import {SettingsRow} from '../../src/components/SettingsRow'
import {Toggle} from '../../src/components/Toggle'
import {Typography} from '../../src/components/Typography'
import {useToast} from '../../src/hooks/useToast'
import {useWalletOptimization} from '../../src/hooks/useWalletOptimization'
import {useI18n} from '../../src/providers'

/**
 * Offered caps. Discrete rather than a free-text field: the useful choice is
 * coarse, and the exact bound is the *size* limit — which the builder measures
 * anyway. A typed number would also need the shared number parser to stay
 * locale-correct for a value that has no locale-correct form.
 */
const INPUT_CAP_CHOICES = [10, 20, 40] as const

export default function WalletOptimizationScreen() {
  const {t} = useI18n()
  const {showToast} = useToast()
  const {policy, loading, setFlag, setInputCap} = useWalletOptimization()

  const reportUnsaved = (saved: boolean) => {
    // A silently-unsaved preference is a lie: the control would read as set and
    // the next launch would disagree with it.
    if (!saved) showToast({variant: 'error', message: t('common.errors.generic')})
  }

  const toggle = (key: Parameters<typeof setFlag>[0]) => (value: boolean) => {
    void setFlag(key, value).then(reportUnsaved)
  }

  const rows = [
    {key: 'autoConsolidate', border: true},
    {key: 'autoWithdrawRewards', border: true},
    {key: 'bundleByPolicy', border: true},
    {key: 'keepPureAdaOutput', border: false},
  ] as const

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <Typography variant="bodySm_regular" style={styles.intro}>
        {t('settings.walletOptimization.intro')}
      </Typography>
      <SettingsGroup>
        {rows.map(({key, border}) => (
          <SettingsRow
            key={key}
            label={t(`settings.walletOptimization.${key}` as never)}
            description={t(`settings.walletOptimization.${key}Description` as never)}
            testID={`wallet-optimization-${key}`}
            size="lg"
            showBorder={border}
          >
            <Toggle
              checked={policy[key]}
              onChange={toggle(key)}
              disabled={loading}
              testID={`wallet-optimization-${key}-toggle`}
            />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <Typography variant="bodySm_regular" style={styles.intro}>
        {t('settings.walletOptimization.inputCapIntro')}
      </Typography>
      {/* `stacked`: SettingsPickerRow brings its own surface, so the default
          card variant would wrap a card in a card — and the selected row's border
          then sits wider than its unselected siblings. */}
      <SettingsGroup label={t('settings.walletOptimization.inputCapTitle')} variant="stacked">
        <SettingsPickerRow
          label={t('settings.walletOptimization.inputCapNoLimit')}
          sublabel={t('settings.walletOptimization.inputCapNoLimitSublabel')}
          selected={policy.maxInputsPerTx === undefined}
          onPress={() => void setInputCap(null).then(reportUnsaved)}
          checkboxVariant="radio"
          testID="wallet-optimization-cap-none"
        />
        {INPUT_CAP_CHOICES.map((cap) => (
          <SettingsPickerRow
            key={cap}
            label={t('settings.walletOptimization.inputCapOption', {count: cap})}
            selected={policy.maxInputsPerTx === cap}
            onPress={() => void setInputCap(cap).then(reportUnsaved)}
            checkboxVariant="radio"
            testID={`wallet-optimization-cap-${cap}`}
          />
        ))}
      </SettingsGroup>
      <View />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  safeArea: {flex: 1},
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    paddingBottom: spacing.spacing80,
    gap: spacing.spacing12,
  },
  intro: {
    color: colors.textAlternative,
    paddingHorizontal: spacing.spacing4,
  },
}))
