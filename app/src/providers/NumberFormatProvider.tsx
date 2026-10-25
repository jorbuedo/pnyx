/**
 * Number format provider.
 *
 * Holds the user's number-format preference — one of five choices:
 * `auto` (match device locale), `us` (`1,234.56`), `eu` (`1.234,56`),
 * `fr` (`1 234,56`, narrow no-break space), or `ch` (`1'234.56`,
 * straight apostrophe).
 *
 * Rules:
 * 1. `auto` reads `getLocales()[0].languageTag` from expo-localization
 *    and resolves to the device's natural separators.
 * 2. Any explicit key (`us` / `eu` / `fr` / `ch`) maps to a canonical
 *    BCP-47 tag and is independent of the UI translation language.
 *
 * Keeps BigNumber's global `FORMAT` in sync with the active locale so
 * any third-party `.toFormat()` call that doesn't pass an explicit
 * descriptor still renders correctly. Our own code always passes
 * locale explicitly.
 *
 * @module
 */

import BigNumber from 'bignumber.js'
import {getLocales} from 'expo-localization'
import {createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState} from 'react'
import {
  type FormatCryptoOptions,
  type FormatFiatOptions,
  type FormatPercentOptions,
  formatCrypto,
  formatFiat,
  formatPercent,
  type NumberLocale,
  numberLocaleToBigNumberFormat,
  type ParseNumberResult,
  parseNumberFromText,
  resolveNumberLocale,
} from '../i18n/number-format'
import {storage} from '../platform/storage'
import {type FormatAmountOptions, formatAmount} from '../utils/number-display'
import type {LocaleCode} from './I18nProvider'

/** One of the five user-facing number-format options. */
export type NumberFormatPreference = 'auto' | 'us' | 'eu' | 'fr' | 'ch'

export const NUMBER_FORMAT_PREFERENCES = ['auto', 'us', 'eu', 'fr', 'ch'] as const

const STORAGE_KEY = '@pnyx/number_format_preference'
const DEFAULT_PREFERENCE: NumberFormatPreference = 'auto'

/**
 * Canonical BCP-47 tag for each explicit preference. These are what
 * `Intl.NumberFormat` receives downstream — the user-visible key
 * (`us`/`eu`/…) never reaches the formatter.
 */
const PREFERENCE_TO_LOCALE: Record<Exclude<NumberFormatPreference, 'auto'>, string> = {
  us: 'en-US',
  eu: 'de-DE',
  fr: 'fr-FR',
  ch: 'de-CH',
}

function resolveDeviceLocale(): string {
  const tag = getLocales()[0]?.languageTag
  return tag && tag.length > 0 ? tag : 'en-US'
}

function preferenceToLocaleTag(pref: NumberFormatPreference): string {
  return pref === 'auto' ? resolveDeviceLocale() : PREFERENCE_TO_LOCALE[pref]
}

export type NumberFormatContextValue = {
  /** The resolved {@link NumberLocale} currently in effect. */
  readonly locale: NumberLocale
  /** The BCP-47 tag of the resolved locale. */
  readonly localeTag: LocaleCode
  /** The active preference key. */
  readonly preference: NumberFormatPreference
  /** Pick a new preference. */
  readonly setPreference: (pref: NumberFormatPreference) => void
}

const NumberFormatContext = createContext<NumberFormatContextValue | null>(null)

export type NumberFormatProviderProps = {
  readonly children: ReactNode
  /** Storage key for persisting the preference — override the default in tests. */
  readonly storageKey?: string
}

export function NumberFormatProvider({children, storageKey = STORAGE_KEY}: NumberFormatProviderProps) {
  const [preference, setPreferenceState] = useState<NumberFormatPreference>(DEFAULT_PREFERENCE)

  useEffect(() => {
    storage.get(storageKey).then((stored) => {
      if (typeof stored !== 'string') return
      if ((NUMBER_FORMAT_PREFERENCES as readonly string[]).includes(stored)) {
        setPreferenceState(stored as NumberFormatPreference)
      }
    })
  }, [storageKey])

  const activeTag = useMemo(() => preferenceToLocaleTag(preference), [preference])
  const locale = useMemo<NumberLocale>(() => resolveNumberLocale(activeTag), [activeTag])

  useEffect(() => {
    BigNumber.config({FORMAT: numberLocaleToBigNumberFormat(locale)})
  }, [locale])

  const setPreference = useCallback(
    (pref: NumberFormatPreference) => {
      setPreferenceState(pref)
      storage.set(storageKey, pref)
    },
    [storageKey],
  )

  const value = useMemo<NumberFormatContextValue>(
    () => ({
      locale,
      localeTag: activeTag as LocaleCode,
      preference,
      setPreference,
    }),
    [locale, activeTag, preference, setPreference],
  )

  return <NumberFormatContext.Provider value={value}>{children}</NumberFormatContext.Provider>
}

export function useNumberFormat(): NumberFormatContextValue {
  const context = useContext(NumberFormatContext)
  if (!context) throw new Error('useNumberFormat must be used within a NumberFormatProvider')
  return context
}

export function useNumberLocale(): NumberLocale {
  return useNumberFormat().locale
}

export function useFormatCrypto(): (value: bigint, options: Omit<FormatCryptoOptions, 'locale'>) => string {
  const {locale} = useNumberFormat()
  return useCallback((value, options) => formatCrypto(value, {...options, locale}), [locale])
}

export function useFormatFiat(): (value: number, options: Omit<FormatFiatOptions, 'locale'>) => string {
  const {locale} = useNumberFormat()
  return useCallback((value, options) => formatFiat(value, {...options, locale}), [locale])
}

export function useFormatPercent(): (value: number, options?: Omit<FormatPercentOptions, 'locale'>) => string {
  const {locale} = useNumberFormat()
  return useCallback((value, options) => formatPercent(value, {...(options ?? {}), locale}), [locale])
}

export function useNumberParser(): (
  text: string,
  options: {readonly decimals: number; readonly precision?: number},
) => ParseNumberResult {
  const {locale} = useNumberFormat()
  return useCallback((text, options) => parseNumberFromText(text, {...options, locale}), [locale])
}

// ---------------------------------------------------------------------------
// Design-system formatter hook
// ---------------------------------------------------------------------------

/**
 * Locale-bound {@link formatAmount}. The single formatter hook for components:
 *   const format = useFormat()
 *   format(value, {preset: 'fiatBalance', currency})
 *   format(balance, {preset: 'cryptoBalance', currency: 'ADA', decimals: 6})
 *
 * For USD-denominated values, convert first with `useToSettingsFiat`.
 */
export function useFormat(): (value: number | bigint, options: Omit<FormatAmountOptions, 'locale'>) => string {
  const {locale} = useNumberFormat()
  return useCallback((value, options) => formatAmount(value, {...options, locale}), [locale])
}
