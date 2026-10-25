import type {translations} from './translations'

/**
 * Recursively extracts all dot-notation paths from a nested object type.
 * Only includes paths that lead to string values.
 */
type PathsToStringValues<T, Prefix extends string = ''> = {
  [K in keyof T]: T[K] extends string
    ? `${Prefix}${K & string}`
    : T[K] extends Record<string, unknown>
      ? PathsToStringValues<T[K], `${Prefix}${K & string}.`>
      : never
}[keyof T]

/**
 * Type-safe translation key - a union of all valid dot-notation paths
 * in the translations object.
 *
 * Example: 'common.buttons.cancel' | 'send.title' | 'dashboard.features.staking'
 */
export type TranslationKey = PathsToStringValues<typeof translations>

/**
 * Values that can be interpolated into translation strings.
 * Placeholders use the format {key}.
 */
export type InterpolationValues = Record<string, string | number | boolean>

/**
 * Locale configuration
 */
export type Locale = {
  code: string
  name: string
  rtl?: boolean
}

/**
 * Number formatting options (subset of Intl.NumberFormatOptions)
 */
export type NumberFormatOptions = {
  minimumFractionDigits?: number
  maximumFractionDigits?: number
  useGrouping?: boolean
}

/**
 * Date formatting options (subset of Intl.DateTimeFormatOptions)
 */
export type DateFormatOptions = {
  dateStyle?: 'full' | 'long' | 'medium' | 'short'
  timeStyle?: 'full' | 'long' | 'medium' | 'short'
}

/**
 * Currency formatting options
 */
export type CurrencyFormatOptions = {
  currency: string
  display?: 'symbol' | 'code' | 'name'
}

/**
 * Relative time units for formatting
 */
export type RelativeTimeUnit =
  | 'year'
  | 'years'
  | 'quarter'
  | 'quarters'
  | 'month'
  | 'months'
  | 'week'
  | 'weeks'
  | 'day'
  | 'days'
  | 'hour'
  | 'hours'
  | 'minute'
  | 'minutes'
  | 'second'
  | 'seconds'

/**
 * Translation provider type
 */
export type TranslationProvider = {
  t: (key: TranslationKey, values?: InterpolationValues) => string
  formatNumber: (value: number, options?: NumberFormatOptions) => string
  formatCurrency: (value: number, options: CurrencyFormatOptions) => string
  formatDate: (date: Date, options?: DateFormatOptions) => string
  formatRelativeTime: (value: number, unit: RelativeTimeUnit) => string
}
