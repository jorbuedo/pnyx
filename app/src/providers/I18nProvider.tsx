/**
 * Internationalization provider.
 *
 * Provides translation functions and locale management.
 *
 * @module
 */

import {getLocales} from 'expo-localization'
import {createContext, type ReactNode, useContext, useEffect, useMemo, useState} from 'react'
import {IntlProvider} from 'react-intl'
import {
  type LocaleCode as _LocaleCode,
  createProvider,
  getLocaleMessages,
  type Locale,
  SUPPORTED_LOCALES,
  type TranslationKey,
  type TranslationProvider,
} from '../i18n'

/** Re-export LocaleCode so consumers can import it from this module. */
export type LocaleCode = _LocaleCode

import {deviceStorage as storage} from '../platform/storage'

const availableLocales: Locale[] = Object.entries(SUPPORTED_LOCALES).map(([code, {nativeName}]) => ({
  code,
  name: nativeName,
  rtl: false,
}))

const supportedCodes = availableLocales.map((l) => l.code as LocaleCode)

/**
 * Maps a device locale tag to the best-matching supported LocaleCode.
 *
 * Matching priority:
 *  1. Exact match              ('es-ES' → 'es-ES')
 *  2. Chinese script match     ('zh-Hans-CN' → 'zh-CN', 'zh-Hant-TW' → 'zh-TW')
 *  3. Language prefix match    ('es-MX' → 'es-ES', 'ja' → 'ja-JP')
 *  4. Fallback                 ('en-US')
 */
function resolveDeviceLocale(): LocaleCode {
  const tag = getLocales()[0]?.languageTag ?? ''

  if (supportedCodes.includes(tag as LocaleCode)) return tag as LocaleCode

  // Chinese script disambiguation before generic language match
  if (tag.includes('Hans')) return 'zh-CN'
  if (tag.includes('Hant')) return 'zh-TW'

  const lang = tag.split('-')[0] ?? ''
  const match = supportedCodes.find((code) => code.startsWith(lang))
  return match ?? 'en-US'
}

export type I18nContextValue = {
  locale: LocaleCode
  setLocale: (locale: LocaleCode) => void
  t: (key: TranslationKey, values?: Record<string, string | number | boolean>) => string
  formatNumber: TranslationProvider['formatNumber']
  formatCurrency: TranslationProvider['formatCurrency']
  formatDate: TranslationProvider['formatDate']
  formatRelativeTime: TranslationProvider['formatRelativeTime']
}

export const I18nContext = createContext<I18nContextValue | null>(null)

export type I18nProviderProps = {
  children: ReactNode
  /** Storage key for persisting locale */
  storageKey?: string
  /**
   * Override the initial locale. When omitted the device locale is used
   * (via expo-localization), falling back to 'en-US' if unsupported.
   */
  initialLocale?: LocaleCode
}

/**
 * Internationalization provider with storage persistence.
 *
 * @example
 * ```tsx
 * <I18nProvider>
 *   <App />
 * </I18nProvider>
 * ```
 */
export function I18nProvider({children, storageKey = 'pnyx_locale', initialLocale}: I18nProviderProps) {
  const [locale, setLocaleState] = useState<LocaleCode>(() => initialLocale ?? resolveDeviceLocale())

  // Load persisted locale on mount (non-blocking)
  useEffect(() => {
    storage.get(storageKey).then((stored) => {
      const validCodes = availableLocales.map((l) => l.code)
      if (stored && validCodes.includes(stored)) {
        setLocaleState(stored as LocaleCode)
      }
    })
  }, [storageKey])

  const setLocale = (newLocale: LocaleCode) => {
    setLocaleState(newLocale)
    storage.set(storageKey, newLocale)
  }

  const provider = useMemo(() => {
    // Create provider with the selected locale for formatting
    // Currently only English translations available
    return createProvider(locale)
  }, [locale])

  const value: I18nContextValue = {
    locale,
    setLocale,
    t: provider.t,
    formatNumber: provider.formatNumber,
    formatCurrency: provider.formatCurrency,
    formatDate: provider.formatDate,
    formatRelativeTime: provider.formatRelativeTime,
  }

  return (
    <I18nContext.Provider value={value}>
      <IntlProvider locale={locale} messages={getLocaleMessages(locale)} defaultLocale="en-US">
        {children}
      </IntlProvider>
    </I18nContext.Provider>
  )
}

/**
 * Hook to access the i18n context.
 *
 * @throws Error if used outside of I18nProvider
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider')
  }
  return context
}

/** Get list of available locales for language picker. */
export function getAvailableLocales() {
  return availableLocales
}
