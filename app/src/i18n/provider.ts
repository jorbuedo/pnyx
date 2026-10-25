import {getLogger} from '@pnyx/logger'
import IntlMessageFormat from 'intl-messageformat'
import {formatFiatWithGlyph, getNumberFormat} from './number-format'
import {translations as enTranslations} from './translations'
import {translations as deTranslations} from './translations_de-DE'
import {translations as esTranslations} from './translations_es-ES'
import {translations as frTranslations} from './translations_fr-FR'
import {translations as idTranslations} from './translations_id-ID'
import {translations as jaTranslations} from './translations_ja-JP'
import {translations as koTranslations} from './translations_ko-KR'
import {translations as ptBRTranslations} from './translations_pt-BR'
import {translations as ruTranslations} from './translations_ru-RU'
import {translations as viTranslations} from './translations_vi-VN'
import {translations as zhCNTranslations} from './translations_zh-CN'
import {translations as zhTWTranslations} from './translations_zh-TW'
import type {
  CurrencyFormatOptions,
  DateFormatOptions,
  InterpolationValues,
  NumberFormatOptions,
  RelativeTimeUnit,
  TranslationKey,
  TranslationProvider,
} from './types'

// Platform-agnostic logger (no React Native deps) so ICU/translation failures
// surface in Sentry via the registry transport instead of vanishing silently.
const logger = getLogger('i18n')

/**
 * Recursively flattens a nested translations object into dot-notation keys.
 * e.g. `{ a: { b: 'val' } }` → `{ 'a.b': 'val' }`
 */
function flattenTranslations(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      result[fullKey] = value
    } else if (value !== null && typeof value === 'object') {
      Object.assign(result, flattenTranslations(value as Record<string, unknown>, fullKey))
    }
  }
  return result
}

export type LocaleConfig = {
  name: string
  nativeName: string
  flag: string
  messages: Record<string, string>
}

/**
 * Single source of truth for all supported locales.
 * Combines display metadata with pre-flattened translation messages so that
 * every t() call is an O(1) property access instead of a recursive traversal.
 */
export const SUPPORTED_LOCALES = {
  'en-US': {
    name: 'English',
    nativeName: 'English',
    flag: '🇺🇸',
    messages: flattenTranslations(enTranslations as unknown as Record<string, unknown>),
  },
  'de-DE': {
    name: 'German',
    nativeName: 'Deutsch',
    flag: '🇩🇪',
    messages: flattenTranslations(deTranslations as unknown as Record<string, unknown>),
  },
  'es-ES': {
    name: 'Spanish',
    nativeName: 'Español',
    flag: '🇪🇸',
    messages: flattenTranslations(esTranslations as unknown as Record<string, unknown>),
  },
  'fr-FR': {
    name: 'French',
    nativeName: 'Français',
    flag: '🇫🇷',
    messages: flattenTranslations(frTranslations as unknown as Record<string, unknown>),
  },
  'id-ID': {
    name: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    flag: '🇮🇩',
    messages: flattenTranslations(idTranslations as unknown as Record<string, unknown>),
  },
  'ja-JP': {
    name: 'Japanese',
    nativeName: '日本語',
    flag: '🇯🇵',
    messages: flattenTranslations(jaTranslations as unknown as Record<string, unknown>),
  },
  'ko-KR': {
    name: 'Korean',
    nativeName: '한국어',
    flag: '🇰🇷',
    messages: flattenTranslations(koTranslations as unknown as Record<string, unknown>),
  },
  'pt-BR': {
    name: 'Portuguese (Brazil)',
    nativeName: 'Português (Brasil)',
    flag: '🇧🇷',
    messages: flattenTranslations(ptBRTranslations as unknown as Record<string, unknown>),
  },
  'ru-RU': {
    name: 'Russian',
    nativeName: 'Русский',
    flag: '🇷🇺',
    messages: flattenTranslations(ruTranslations as unknown as Record<string, unknown>),
  },
  'vi-VN': {
    name: 'Vietnamese',
    nativeName: 'Tiếng Việt',
    flag: '🇻🇳',
    messages: flattenTranslations(viTranslations as unknown as Record<string, unknown>),
  },
  'zh-CN': {
    name: 'Chinese (Simplified)',
    nativeName: '中文',
    flag: '🇨🇳',
    messages: flattenTranslations(zhCNTranslations as unknown as Record<string, unknown>),
  },
  'zh-TW': {
    name: 'Chinese (Traditional)',
    nativeName: '繁體中文',
    flag: '🇹🇼',
    messages: flattenTranslations(zhTWTranslations as unknown as Record<string, unknown>),
  },
} satisfies Record<string, LocaleConfig>

export type LocaleCode = keyof typeof SUPPORTED_LOCALES

/**
 * Cache of parsed ICU MessageFormat templates keyed by `(locale, template)`.
 * Parsing is non-trivial for plural / select shapes; on hot screens that
 * call `t()` hundreds of times per render this avoids re-parsing the same
 * key every tick. Lazy population, no TTL — locale codes and template
 * strings are immutable for the session, and the worst-case Map size
 * (~12 locales × ~3k keys = 36k entries) is well under any meaningful
 * memory budget. Real-world session size stays in the hundreds.
 *
 * Exported for test-time inspection — production code MUST NOT mutate.
 */
export const messageFormatCache = new Map<string, IntlMessageFormat>()

function getMessageFormat(template: string, locale: string): IntlMessageFormat {
  const cacheKey = `${locale}\u0000${template}`
  let mf = messageFormatCache.get(cacheKey)
  if (mf === undefined) {
    mf = new IntlMessageFormat(template, locale)
    messageFormatCache.set(cacheKey, mf)
  }
  return mf
}

/**
 * Interpolates values into an ICU MessageFormat template.
 *
 * Handles plain `{key}` placeholders (backward-compatible with the prior
 * regex interpolator) and the full ICU grammar (`{count, plural, …}`,
 * `{value, select, …}`, `#`-substitution with locale grouping, etc.).
 * Locale drives CLDR plural-category selection — `count: 3` resolves to
 * the `few` branch under `ru-RU`, the `other` branch under `en-US`.
 *
 * Defensive: if `IntlMessageFormat.format` throws on a malformed template
 * or a missing required argument, falls back to returning the unparsed
 * template (preserves the prior "leave `{key}` in place" failure mode
 * rather than crashing the screen).
 */
export function interpolate(template: string, values: InterpolationValues | undefined, locale: string): string {
  if (!values) return template
  try {
    // `.format` returns `T | T[]` — string when all parts coerce cleanly, an
    // array when a value's type isn't natively renderable (e.g. boolean).
    // `Array.join('')` does the per-element `String(...)` we want.
    const formatted = getMessageFormat(template, locale).format(values)
    return Array.isArray(formatted) ? formatted.join('') : (formatted as string)
  } catch (err) {
    logger.warn(`ICU format failed for template "${template}" (locale=${locale})`, {origin: 'i18n', err: String(err)})
    return template
  }
}

/**
 * Creates a translator function for the given locale.
 * Falls back to English if a key is missing from the selected locale.
 * Falls back to the key itself only if English also lacks the key.
 */
export function createTranslator(locale: string): TranslationProvider['t'] {
  const localeDict = SUPPORTED_LOCALES[locale as LocaleCode]?.messages
  const enDict = SUPPORTED_LOCALES['en-US'].messages

  return (key: TranslationKey, values?: InterpolationValues): string => {
    const message = localeDict?.[key] ?? enDict?.[key]

    if (message === undefined) {
      logger.warn(`Translation not found for key: ${key}`, {origin: 'i18n'})
      return `!!${key}`
    }

    return interpolate(message, values, locale)
  }
}

/**
 * Normalizes relative time unit to singular form for Intl.RelativeTimeFormat.
 */
function normalizeUnit(unit: RelativeTimeUnit): Intl.RelativeTimeFormatUnit {
  const unitMap: Record<string, Intl.RelativeTimeFormatUnit> = {
    years: 'year',
    quarters: 'quarter',
    months: 'month',
    weeks: 'week',
    days: 'day',
    hours: 'hour',
    minutes: 'minute',
    seconds: 'second',
  }
  return unitMap[unit] ?? (unit as Intl.RelativeTimeFormatUnit)
}

/**
 * Creates a number formatter for the given locale.
 */
export function createNumberFormatter(locale: string): TranslationProvider['formatNumber'] {
  return (value: number, options?: NumberFormatOptions): string => {
    return getNumberFormat(locale, options).format(value)
  }
}

/**
 * Creates a date formatter for the given locale.
 */
export function createDateFormatter(locale: string): TranslationProvider['formatDate'] {
  return (date: Date, options?: DateFormatOptions): string => {
    return new Intl.DateTimeFormat(locale, options).format(date)
  }
}

/**
 * Creates a currency formatter for the given locale.
 */
export function createCurrencyFormatter(locale: string): TranslationProvider['formatCurrency'] {
  return (value: number, options: CurrencyFormatOptions): string => {
    // Narrow glyph by default so this matches `formatFiat` / the currency
    // picker ($ not CA$, kr not SEK). Callers may still pass `display`.
    const display = options.display ?? 'narrowSymbol'
    const nf = getNumberFormat(locale, {style: 'currency', currency: options.currency, currencyDisplay: display})
    // Apply the curated glyph override (CAD→C$, …) for symbol display only —
    // never when the caller explicitly asked for the ISO code / name. Shares
    // the same override source as formatFiat / getCurrencySymbol.
    return display === 'code' || display === 'name'
      ? nf.format(value)
      : formatFiatWithGlyph(nf, value, options.currency)
  }
}

/**
 * Creates a relative time formatter for the given locale.
 */
export function createRelativeTimeFormatter(locale: string): TranslationProvider['formatRelativeTime'] {
  return (value: number, unit: RelativeTimeUnit): string => {
    const formatter = new Intl.RelativeTimeFormat(locale, {numeric: 'auto'})
    return formatter.format(value, normalizeUnit(unit))
  }
}

/**
 * Returns the pre-flattened message map for a locale, falling back to English.
 * Used to supply messages to react-intl's IntlProvider.
 */
export function getLocaleMessages(locale: string): Record<string, string> {
  return SUPPORTED_LOCALES[locale as LocaleCode]?.messages ?? SUPPORTED_LOCALES['en-US'].messages
}

/**
 * Creates a complete translation provider for the given locale.
 */
export function createProvider(locale: string): TranslationProvider {
  return {
    t: createTranslator(locale),
    formatNumber: createNumberFormatter(locale),
    formatDate: createDateFormatter(locale),
    formatCurrency: createCurrencyFormatter(locale),
    formatRelativeTime: createRelativeTimeFormatter(locale),
  }
}
