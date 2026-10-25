/**
 * Language selection screen.
 *
 * Allows users to select their preferred app display language.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsPickerRow} from '../../src/components/SettingsPickerRow'
import {Typography} from '../../src/components/Typography'
import {SUPPORTED_LOCALES} from '../../src/i18n'
import {type LocaleCode, useI18n} from '../../src/providers'

// ⚠️ No flag, deliberately. `SUPPORTED_LOCALES` still carries one, but a flag names a country and
// the row names a language: English was flying the US flag, and Spanish and Portuguese each pick one
// of the many countries that speak them. The native name below the label is the thing a speaker
// actually scans for.
const LANGUAGES = Object.entries(SUPPORTED_LOCALES).map(([code, {name, nativeName}]) => ({
  code: code as LocaleCode,
  name,
  nativeName,
}))

export default function LanguageScreen() {
  const {t, locale, setLocale} = useI18n()

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <Typography variant="bodySm_regular" style={styles.intro}>
        {t('settings.language.intro')}
      </Typography>
      <View style={styles.list}>
        {LANGUAGES.map((language) => (
          <SettingsPickerRow
            key={language.code}
            label={language.name}
            sublabel={language.nativeName}
            selected={language.code === locale}
            onPress={() => setLocale(language.code)}
            testID={`language-option-${language.code}`}
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
