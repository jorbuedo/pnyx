/**
 * Currency selection screen — the fiat currency used for balance + limit display
 * across the app. Only currencies the app can actually price are offered
 * (`SUPPORTED_FIAT_CURRENCIES` = SteelSwap's quote set, USD/EUR today); offering
 * a currency that would show no fiat anywhere would be a broken promise.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsPickerRow} from '../../src/components/SettingsPickerRow'
import {Typography} from '../../src/components/Typography'
import {useConfig, useI18n} from '../../src/providers'
import {FIAT_SYMBOLS} from '../../src/providers/fiat-currencies'
import {SUPPORTED_FIAT_CURRENCIES} from '../../src/services/cardano-assets'

export default function CurrencyScreen() {
  const {t} = useI18n()
  const {currency, setCurrency} = useConfig()

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <Typography variant="bodySm_regular" style={styles.intro}>
        {t('settings.currency.intro')}
      </Typography>
      <View style={styles.list}>
        {SUPPORTED_FIAT_CURRENCIES.map((code) => (
          <SettingsPickerRow
            key={code}
            label={t(`settings.currency.currencies.${code.toLowerCase()}` as never)}
            sublabel={t('settings.currency.symbolSublabel', {symbol: FIAT_SYMBOLS[code]})}
            selected={code === currency}
            onPress={() => {
              void setCurrency(code)
            }}
            testID={`currency-option-${code}`}
            checkboxVariant="radio"
          />
        ))}
      </View>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    paddingBottom: spacing.spacing80,
    gap: spacing.spacing12,
  },
  intro: {
    color: colors.textAlternative,
    paddingHorizontal: spacing.spacing4,
  },
  list: {
    gap: spacing.spacing6,
  },
}))
