/**
 * Number format selection screen.
 *
 * Five separator-only options (Auto / US / EU / FR / CH) decoupled from
 * the UI translation language, with a live preview card at the top.
 *
 * @module
 */

import {getLocales} from 'expo-localization'
import {useMemo} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Card} from '../../src/components/Card'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsPickerRow} from '../../src/components/SettingsPickerRow'
import {Typography} from '../../src/components/Typography'
import {useToast} from '../../src/hooks/useToast'
import {formatCrypto, formatFiat, type NumberLocale, resolveNumberLocale} from '../../src/i18n/number-format'
import {type NumberFormatPreference, useI18n, useNumberFormat} from '../../src/providers'

type Option = {
  readonly id: NumberFormatPreference
  readonly label: string
  readonly sample: string
}

// Canonical samples for the four explicit formats. Order matches the spec.
const OPTIONS: ReadonlyArray<Option> = [
  {id: 'us', label: '1,234.56', sample: '1,234.56'},
  {id: 'eu', label: '1.234,56', sample: '1.234,56'},
  {id: 'fr', label: '1 234,56', sample: '1 234,56'},
  {id: 'ch', label: "1'234.56", sample: "1'234.56"},
]

function countrySublabelFor(pref: NumberFormatPreference, t: ReturnType<typeof useI18n>['t']): string | undefined {
  switch (pref) {
    case 'us':
      return t('settings.numberFormat.usSublabel')
    case 'eu':
      return t('settings.numberFormat.euSublabel')
    case 'fr':
      return t('settings.numberFormat.frSublabel')
    case 'ch':
      return t('settings.numberFormat.chSublabel')
    default:
      return undefined
  }
}

// Preview values — large enough to exercise grouping + decimals in every locale.
const PREVIEW_BALANCE = 12_456.78 // fiat
const PREVIEW_SEND = 1_234_567_800_000_000_000n // 1.2345678 ETH in wei
const PREVIEW_FEE = 12_000_000_000_000n // 0.000012 ETH in wei

function resolveAutoLocaleTag(): string {
  const tag = getLocales()[0]?.languageTag
  return tag && tag.length > 0 ? tag : 'en-US'
}

function sampleForLocale(locale: NumberLocale): string {
  // "1,234.56"-style label for the Auto sample.
  return `1${locale.group}234${locale.decimal}56`
}

export default function NumberFormatScreen() {
  const {t} = useI18n()
  const {preference, setPreference, locale: activeLocale} = useNumberFormat()
  const {showToast} = useToast()

  const autoOption = useMemo<Option>(() => {
    const tag = resolveAutoLocaleTag()
    const resolved = resolveNumberLocale(tag)
    return {
      id: 'auto',
      label: t('settings.numberFormat.autoLabel'),
      sample: sampleForLocale(resolved),
    }
  }, [t])

  const rows: ReadonlyArray<Option> = useMemo(() => [autoOption, ...OPTIONS], [autoOption])

  const previewBalance = formatFiat(PREVIEW_BALANCE, {
    locale: activeLocale,
    currency: 'USD',
    minFractionDigits: 2,
    maxFractionDigits: 2,
  })
  const previewSend = formatCrypto(PREVIEW_SEND, {locale: activeLocale, decimals: 18, maxFractionDigits: 4})
  const previewFee = formatCrypto(PREVIEW_FEE, {locale: activeLocale, decimals: 18, maxFractionDigits: 6})

  const handleSelect = (pref: NumberFormatPreference) => {
    if (pref === preference) return
    setPreference(pref)
    const next = rows.find((r) => r.id === pref) ?? autoOption
    showToast({
      variant: 'success',
      message: t('settings.numberFormat.updatedToast', {format: next.sample}),
    })
  }

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <Typography variant="bodySm_regular" style={styles.intro}>
        {t('settings.numberFormat.intro')}
      </Typography>

      {/* Live preview — re-renders as the user taps each option */}
      <Card style={styles.previewCard}>
        <Typography variant="bodyXs_medium" style={styles.previewLabel}>
          {t('settings.numberFormat.previewTitle')}
        </Typography>
        <View style={styles.previewRow}>
          <Typography variant="bodySm_regular" style={styles.previewKey}>
            {t('settings.numberFormat.previewBalance')}
          </Typography>
          <Typography variant="bodyMd_medium" style={styles.previewValue}>
            {previewBalance}
          </Typography>
        </View>
        <View style={styles.previewDivider} />
        <View style={styles.previewRow}>
          <Typography variant="bodySm_regular" style={styles.previewKey}>
            {t('settings.numberFormat.previewSendAmount')}
          </Typography>
          <Typography variant="bodyMd_medium" style={styles.previewValue}>
            {previewSend} ETH
          </Typography>
        </View>
        <View style={styles.previewDivider} />
        <View style={styles.previewRow}>
          <Typography variant="bodySm_regular" style={styles.previewKey}>
            {t('settings.numberFormat.previewNetworkFee')}
          </Typography>
          <Typography variant="bodyMd_medium" style={styles.previewValue}>
            {previewFee} ETH
          </Typography>
        </View>
      </Card>

      <View style={styles.list}>
        {rows.map((row) => {
          const selected = row.id === preference
          const sublabel =
            row.id === 'auto'
              ? t('settings.numberFormat.autoSublabel', {sample: row.sample})
              : countrySublabelFor(row.id, t)
          return (
            <SettingsPickerRow
              key={row.id}
              label={row.label}
              sublabel={sublabel}
              selected={selected}
              onPress={() => handleSelect(row.id)}
              testID={`number-format-option-${row.id}`}
              checkboxVariant="radio"
            />
          )
        })}
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
    gap: spacing.spacing16,
  },
  intro: {
    color: colors.textAlternative,
    paddingHorizontal: spacing.spacing4,
  },
  previewCard: {
    padding: spacing.spacing16,
    gap: spacing.spacing8,
  },
  previewLabel: {
    color: colors.textAlternative,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  previewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: spacing.spacing12,
  },
  previewKey: {
    color: colors.textAlternative,
  },
  previewValue: {
    color: colors.textDefault,
    fontVariant: ['tabular-nums'],
  },
  previewDivider: {
    height: 1,
    backgroundColor: colors.borderDefaultWeak,
  },
  list: {
    gap: spacing.spacing6,
  },
}))
