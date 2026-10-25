/**
 * Number display formatting utilities implementing the design system spec.
 *
 * Handles token balances, fiat values, token prices, percentages, network fees,
 * and activity amounts with locale-aware separators, subscript zero
 * compression, and M/B abbreviation.
 *
 * The single public entry point is {@link formatAmount} — pick an
 * {@link AmountPreset}, pass an ISO code (fiat) or ticker (crypto) and an
 * optional `locale`. The per-shape functions (`formatFiatBalance`,
 * `formatTokenPrice`, …) are private helpers behind it. For USD-denominated
 * backend data, convert first with `toSettingsFiat` (see `../hooks/price-conversion`)
 * and spread the result into `formatAmount`.
 *
 * React call sites should prefer `useFormat()` in
 * `../providers/NumberFormatProvider`, which binds the active locale from
 * context and wraps `formatAmount`. When a `locale` is omitted here, en-US
 * conventions are used as an invariant fallback.
 *
 * @module
 */

import {
  EN_US_NUMBER_LOCALE,
  formatFiat,
  formatGroupedInteger,
  formatLocalizedNumber,
  type NumberLocale,
} from '../i18n/number-format'
import {bigIntToDecimalStr} from './amount'

/**
 * Convert a bigint atomic-unit amount to the closest JS number via its exact
 * decimal-string representation. Unlike `Number(value)/10**decimals` or
 * `bigintToHumanNumber`, the result is the double whose `toString()` matches
 * the lossless decimal — so callers that pipe the value through a rounding
 * formatter never see float artifacts like `1.9308800000000002`.
 */
const bigintToDisplayNumber = (value: bigint, decimals: number): number => Number(bigIntToDecimalStr(value, decimals))

/** Unicode subscript digits for zero compression (0.000001 → 0.0₆1). */
export const SUBSCRIPT_DIGITS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'] as const

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count leading zeros after the decimal point.
 * e.g. 0.000123 → 3, 0.5 → 0, 1.5 → 0
 */
function countLeadingDecimalZeros(value: number): number {
  if (value <= 0 || value >= 1) return 0
  // Use the exponent from scientific notation for accuracy
  const match = value.toExponential().match(/e-(\d+)/)
  if (!match) return 0
  const exp = match[1]
  if (exp === undefined) return 0
  return Number.parseInt(exp, 10) - 1
}

/**
 * Extract significant digits from a small number (< 1) after the leading zeros.
 * Uses `toExponential` with bounded precision to avoid FP noise at the 15th+ digit.
 *
 * @param precision - Number of significant digits to extract (default 10, more than
 *   enough for any display context while staying below FP noise).
 *
 * e.g. 0.000123 → "123", 0.0000021333494 → "2133349400"
 */
function extractSignificantDigits(value: number, precision = 10): string {
  // toExponential(n-1) gives n significant digits with proper rounding.
  // e.g. (0.000000123).toExponential(9) → "1.230000000e-7"
  const exp = value.toExponential(precision - 1)
  const mantissa = exp.split('e')[0] ?? '0'
  return mantissa.replace('.', '').replace(/^0+/, '').replace(/0+$/, '') || '0'
}

/**
 * Format a number with subscript zero compression.
 * Applies when value > 0 and value < 0.001, compressing leading zeros.
 *
 * The notation "0.0₅123" means: after the decimal point there are 5 zeros,
 * then the significant digits 123.
 *
 * Returns `null` if subscript notation does not apply.
 */
function formatSubscript(value: number, locale: NumberLocale, maxSignificantDigits = 6): string | null {
  const zeros = countLeadingDecimalZeros(value)
  if (zeros < 2) return null // Need at least 2 zeros (i.e. value < 0.01) to use subscript

  const significant = extractSignificantDigits(value).slice(0, maxSignificantDigits)
  const subscript = String(zeros)
    .split('')
    .map((d) => SUBSCRIPT_DIGITS[Number.parseInt(d, 10)])
    .join('')

  return `0${locale.decimal}0${subscript}${significant}`
}

/**
 * Format with K/M/B abbreviation. By default kicks in at 1,000,000; pass
 * `includeThousands: true` to abbreviate from 1,000 up. Uses 2 decimal places
 * by default, trims trailing zeros (but removes .00 entirely).
 */
function formatAbbreviated(value: number, locale: NumberLocale, maxDecimals = 2, includeThousands = false): string {
  let divisor: number
  let suffix: string

  if (value >= 1_000_000_000) {
    divisor = 1_000_000_000
    suffix = 'B'
  } else if (value >= 1_000_000) {
    divisor = 1_000_000
    suffix = 'M'
  } else if (includeThousands) {
    divisor = 1_000
    suffix = 'K'
  } else {
    divisor = 1_000_000
    suffix = 'M'
  }

  const divided = value / divisor
  const formatted = formatLocalizedNumber(divided, {locale, minFrac: 0, maxFrac: maxDecimals})

  return `${trimTrailingZeros(formatted, locale.decimal)}${suffix}`
}

/**
 * Format a fiat balance with aggressive K/M/B abbreviation from $1,000 up.
 * For tight contexts (donut centers, chart labels) where `formatFiatBalance`'s
 * default 1M threshold leaves 4-6 digit values too wide.
 *
 * @param currency ISO 4217 code — drives the symbol and locale-correct placement.
 */
function formatFiatCompact(value: number, currency: string, locale: NumberLocale = EN_US_NUMBER_LOCALE): string {
  const noDecimals = {currency, locale, minFractionDigits: 0, maxFractionDigits: 0} as const
  if (!Number.isFinite(value)) return formatFiat(0, noDecimals)
  const safe = Math.max(0, value)
  // Round first: values in [999.5, 1000) round up to 1000 and must take the
  // abbreviated path, otherwise we'd render "$1000" instead of "$1K". Once
  // we've decided to abbreviate, force the compact path (threshold 0) so the
  // sub-1000 boundary value (999.5) still collapses to "$1K".
  const rounded = Math.round(safe)
  if (rounded < 1_000) return formatFiat(rounded, noDecimals)
  // Boundary values [999.5, 1000) round up to 1000 but Intl's compact notation
  // won't abbreviate anything below 1000 — bump them so they render "$1K"
  // rather than "$999.5".
  const compactValue = safe < 1_000 ? 1_000 : safe
  return formatFiat(compactValue, {currency, locale, abbreviate: true, abbreviateThreshold: 0})
}

/**
 * Format a number with grouping and decimal places.
 */
function formatLocale(value: number, minDec: number, maxDec: number, locale: NumberLocale): string {
  return formatLocalizedNumber(value, {locale, minFrac: minDec, maxFrac: maxDec})
}

/**
 * Count the number of integer digits (before the decimal point).
 * Always returns at least 1 (for values like 0.xxx).
 */
function integerDigitCount(value: number): number {
  const abs = Math.abs(value)
  if (abs < 1) return 1
  return Math.floor(Math.log10(abs)) + 1
}

/**
 * Format a number respecting a max total digit count (integer + decimal digits).
 * Reduces decimal places as the integer part grows.
 */
function formatMaxDigits(value: number, maxTotal: number, defaultDecimals: number, locale: NumberLocale): string {
  const intDigits = integerDigitCount(value)
  const available = Math.max(0, Math.min(defaultDecimals, maxTotal - intDigits))
  const minDec = Math.min(2, available)
  return formatLocale(value, minDec, available, locale)
}

/**
 * Trim trailing zeros after the decimal point, keeping at least 2 decimal places.
 * If all decimals are zero (e.g. ".00"), removes the decimal part entirely.
 *
 * Examples (en-US):
 *   "0.51000" → "0.51"
 *   "1.20"    → "1.20"
 *   "1.00"    → "1"
 *   "1.50000" → "1.50"
 */
function trimTrailingZerosMinTwo(formatted: string, decimalSep: string): string {
  const sepIdx = formatted.indexOf(decimalSep)
  if (sepIdx === -1) return formatted

  const intPart = formatted.slice(0, sepIdx)
  const fracPart = formatted.slice(sepIdx + decimalSep.length)

  // All zeros → omit decimals entirely
  if (/^0+$/.test(fracPart)) return intPart

  // Trim trailing zeros, but keep at least 2 decimal places
  let trimmed = fracPart.replace(/0+$/, '')
  if (trimmed.length < 2) trimmed = trimmed.padEnd(2, '0')

  return `${intPart}${decimalSep}${trimmed}`
}

/**
 * Trim all trailing zeros after the decimal (no minimum preserved).
 * Removes the decimal point if no fractional digits remain.
 */
function trimTrailingZeros(formatted: string, decimalSep: string): string {
  const sepIdx = formatted.indexOf(decimalSep)
  if (sepIdx === -1) return formatted

  const intPart = formatted.slice(0, sepIdx)
  const trimmed = formatted.slice(sepIdx + decimalSep.length).replace(/0+$/, '')

  return trimmed ? `${intPart}${decimalSep}${trimmed}` : intPart
}

// ---------------------------------------------------------------------------
// Public API — Token Balances
// ---------------------------------------------------------------------------

/**
 * Format a token balance for display.
 *
 * - Max 8 digits total, default 5 decimals
 * - Over 1M: abbreviate with M/B (2 decimals, trim trailing zeros)
 * - Under 0.001: subscript zero compression
 * - Trim trailing zeros, min 2 decimal places (omit if .00)
 * - Thousands separator for values >= 1,000
 *
 * @example
 * formatTokenBalance(89.87435)          // "89.87435"
 * formatTokenBalance(0.12552)           // "0.12552"
 * formatTokenBalance(1034.1455)         // "1,034.1455"
 * formatTokenBalance(134234.14)         // "134,234.14"
 * formatTokenBalance(3153839.32)        // "3.15M"
 * formatTokenBalance(30000000000)       // "30B"
 * formatTokenBalance(12343153839.32)    // "12.34B"
 * formatTokenBalance(0.000000123)       // "0.0₆123"
 * formatTokenBalance(1)                 // "1"
 * formatTokenBalance(1.2)              // "1.20"
 * formatTokenBalance(0.51)             // "0.51"
 */
function formatTokenBalance(value: number, locale?: NumberLocale): string
function formatTokenBalance(balance: bigint, decimals: number, locale?: NumberLocale): string
function formatTokenBalance(
  valueOrBalance: number | bigint,
  decimalsOrLocale?: number | NumberLocale,
  maybeLocale?: NumberLocale,
): string {
  const {value, locale} =
    typeof valueOrBalance === 'bigint'
      ? {
          value: bigintToDisplayNumber(valueOrBalance, decimalsOrLocale as number),
          locale: maybeLocale ?? EN_US_NUMBER_LOCALE,
        }
      : {value: valueOrBalance, locale: (decimalsOrLocale as NumberLocale | undefined) ?? EN_US_NUMBER_LOCALE}

  if (value === 0) return '0'

  if (value >= 1_000_000) return formatAbbreviated(value, locale)

  if (value > 0 && value < 0.001) {
    const sub = formatSubscript(value, locale)
    if (sub) return sub
  }

  const formatted = formatMaxDigits(value, 8, 5, locale)
  return trimTrailingZerosMinTwo(formatted, locale.decimal)
}

// ---------------------------------------------------------------------------
// Public API — Fiat Balances
// ---------------------------------------------------------------------------

/**
 * Format a fiat balance for display.
 *
 * - Integers render without `.00`; fractional values are right-padded to 2 decimals
 * - Over 1M: abbreviate with M/B (2 decimals)
 * - Below the smallest representable cent (0 < value < 0.01): render as
 *   `<{symbol}0.01` (e.g. `<$0.01`) — fiat must never use crypto-style
 *   subscript-zero compression
 * - Currency placement / spacing follows the locale (e.g. en-US `$1,234.56`
 *   vs. de-DE `1.234,56 €`) via `Intl.NumberFormat({style: 'currency'})`
 *
 * @param currency ISO 4217 code (`'USD'`, `'EUR'`, `'JPY'`, …) — drives the
 *                 currency symbol and locale-correct placement
 *
 * @example
 * formatFiatBalance(0.13, 'EUR', enUS)        // "€0.13"
 * formatFiatBalance(1034.14, 'EUR', enUS)     // "€1,034.14"
 * formatFiatBalance(4150000, 'EUR', enUS)     // "€4.15M"
 * formatFiatBalance(0.005, 'USD', enUS)       // "<$0.01"
 * formatFiatBalance(1, 'EUR', enUS)           // "€1"
 * formatFiatBalance(1.2, 'USD', enUS)         // "$1.20"
 * formatFiatBalance(1234.56, 'EUR', deDE)     // "1.234,56 €"   (locale-correct suffix)
 */
function formatFiatBalance(value: number, currency: string, locale: NumberLocale = EN_US_NUMBER_LOCALE): string {
  if (value === 0) {
    return formatFiat(0, {currency, locale, minFractionDigits: 0, maxFractionDigits: 0})
  }
  if (value > 0 && value < 0.01) {
    return `<${formatFiat(0.01, {currency, locale, minFractionDigits: 2, maxFractionDigits: 2})}`
  }
  if (value >= 1_000_000) {
    return formatFiat(value, {currency, locale, abbreviate: true, abbreviateThreshold: 1_000_000})
  }
  // Integers render without `.00`; fractional values are right-padded to 2.
  const isInteger = value === Math.trunc(value)
  return formatFiat(value, {
    currency,
    locale,
    minFractionDigits: isInteger ? 0 : 2,
    maxFractionDigits: 2,
  })
}

// ---------------------------------------------------------------------------
// Public API — Token Prices
// ---------------------------------------------------------------------------

/**
 * Format a token price in fiat for display.
 *
 * - Under 0.001: subscript-zero compression (e.g. `$0.0₅213` for 0.000002133)
 * - Otherwise: up to 5 decimal places; integers display without `.00`,
 *   fractional values keep at least 2 decimals
 * - Currency placement / spacing follows the locale via
 *   `Intl.NumberFormat({style: 'currency'})`
 *
 * @param currency ISO 4217 code (`'USD'`, `'EUR'`, `'JPY'`, …)
 *
 * @example
 * formatTokenPrice(0.00512, 'EUR', enUS)              // "€0.00512"
 * formatTokenPrice(1034.1455, 'USD', enUS)            // "$1,034.1455"
 * formatTokenPrice(0.00000123, 'EUR', enUS)           // "€0.0₅123"
 * formatTokenPrice(1, 'EUR', enUS)                    // "€1"
 * formatTokenPrice(1.2, 'USD', enUS)                  // "$1.20"
 */
function formatTokenPrice(value: number, currency: string, locale: NumberLocale = EN_US_NUMBER_LOCALE): string {
  if (value === 0) {
    return formatFiat(0, {currency, locale, minFractionDigits: 0, maxFractionDigits: 0})
  }
  if (value > 0 && value < 0.001) {
    // 6 significant digits preserves the prior token-price precision; the
    // subscript count follows `formatFiat`'s shared convention (one literal
    // `0` then the subscripted remaining-zero count) so the whole app uses a
    // single subscript notation rather than this file's older variant.
    return formatFiat(value, {currency, locale, subscript: true, subscriptThreshold: 0.001, subscriptSigDigits: 6})
  }
  const isInteger = value === Math.trunc(value)
  return formatFiat(value, {
    currency,
    locale,
    minFractionDigits: isInteger ? 0 : 2,
    maxFractionDigits: 5,
  })
}

// ---------------------------------------------------------------------------
// Public API — Network Fees
// ---------------------------------------------------------------------------

/**
 * Format a network fee in fiat.
 *
 * - Always 2 decimal places
 * - Under 0.01: show `<{symbol}0.01`
 * - Currency placement follows the locale via `Intl.NumberFormat`
 *
 * @param currency ISO 4217 code (`'USD'`, `'EUR'`, …)
 *
 * @example
 * formatNetworkFeeFiat(0.36, 'EUR', enUS)    // "€0.36"
 * formatNetworkFeeFiat(0.005, 'EUR', enUS)   // "<€0.01"
 * formatNetworkFeeFiat(12.5, 'USD', enUS)    // "$12.50"
 */
function formatNetworkFeeFiat(value: number, currency: string, locale: NumberLocale = EN_US_NUMBER_LOCALE): string {
  const twoDecimals = {currency, locale, minFractionDigits: 2, maxFractionDigits: 2} as const
  if (value === 0) return formatFiat(0, {currency, locale, minFractionDigits: 0, maxFractionDigits: 0})
  if (value > 0 && value < 0.01) return `<${formatFiat(0.01, twoDecimals)}`
  return formatFiat(value, twoDecimals)
}

/**
 * Format a network fee in token value.
 *
 * - Max 8 digits total, no subscript compression
 * - Trim trailing zeros, min 2 decimal places (omit if .00)
 *
 * @example
 * formatNetworkFeeToken(0.000123)      // "0.000123"
 * formatNetworkFeeToken(1.23456789)    // "1.2345678"
 * formatNetworkFeeToken(0.5)           // "0.50"
 */
function formatNetworkFeeToken(value: number, locale: NumberLocale = EN_US_NUMBER_LOCALE): string {
  if (value === 0) return '0'

  const formatted = formatMaxDigits(value, 8, 8, locale)
  return trimTrailingZerosMinTwo(formatted, locale.decimal)
}

// ---------------------------------------------------------------------------
// Public API — Activity / Sent / Received Amounts
// ---------------------------------------------------------------------------

/**
 * Format a crypto amount for activity list and total display.
 *
 * - Under 0.001: subscript zero compression
 * - Over 1M: M/B abbreviation (2 decimals)
 * - Max 8 digits total, max 6 decimals
 * - Trim trailing zeros, min 2 decimal places (omit if .00)
 *
 * @example
 * formatActivityCrypto(3153839.32)      // "3.15M"
 * formatActivityCrypto(30000000000)     // "30B"
 * formatActivityCrypto(0.000000123)     // "0.0₆123"
 * formatActivityCrypto(1234.5678)       // "1,234.5678"
 */
function formatActivityCrypto(value: number, locale?: NumberLocale): string
function formatActivityCrypto(balance: bigint, decimals: number, locale?: NumberLocale): string
function formatActivityCrypto(
  valueOrBalance: number | bigint,
  decimalsOrLocale?: number | NumberLocale,
  maybeLocale?: NumberLocale,
): string {
  const {value, locale} =
    typeof valueOrBalance === 'bigint'
      ? {
          value: bigintToDisplayNumber(valueOrBalance, decimalsOrLocale as number),
          locale: maybeLocale ?? EN_US_NUMBER_LOCALE,
        }
      : {value: valueOrBalance, locale: (decimalsOrLocale as NumberLocale | undefined) ?? EN_US_NUMBER_LOCALE}

  if (value === 0) return '0'

  if (value >= 1_000_000) return formatAbbreviated(value, locale)

  if (value > 0 && value < 0.001) {
    const sub = formatSubscript(value, locale)
    if (sub) return sub
  }

  const formatted = formatMaxDigits(value, 8, 6, locale)
  return trimTrailingZerosMinTwo(formatted, locale.decimal)
}

/**
 * Format a crypto amount for transaction detail display.
 *
 * - Under 0.001: subscript zero compression
 * - Over 0.001: show value with max 6 decimal places; append "..." if truncated
 * - Trim trailing zeros, min 2 decimal places (omit if .00)
 *
 * The caller should provide a tooltip with the full untruncated value when "..."
 * is present.
 *
 * @example
 * formatTxDetailCrypto(0.000000123)      // "0.0₆123"
 * formatTxDetailCrypto(1.123456789)      // "1.123456…"
 * formatTxDetailCrypto(1234.56)          // "1,234.56"
 * formatTxDetailCrypto(1)               // "1"
 */
function formatTxDetailCrypto(value: number, locale: NumberLocale = EN_US_NUMBER_LOCALE): string {
  if (value === 0) return '0'

  const abs = Math.abs(value)
  const negative = value < 0

  if (abs < 0.001) {
    const sub = formatSubscript(abs, locale)
    if (sub) return negative ? `-${sub}` : sub
  }

  const intPart = Math.trunc(value)
  const hasFraction = abs !== Math.abs(intPart)

  // Detect truncation: compare toFixed at 6 and 7 digits. If they differ after
  // trimming trailing zeros, the value has more than 6 meaningful fractional digits.
  // This avoids toFixed(20) FP noise (e.g. 1234.56 → "1234.55999…").
  let willTruncate = false
  if (hasFraction) {
    const at6 = abs.toFixed(6).replace(/0+$/, '')
    const at7 = abs.toFixed(7).replace(/0+$/, '')
    willTruncate = at7.length > at6.length
  }

  // `intPart` came out of `Math.trunc` on a finite `number`, so it's safe to
  // keep as a number; the helper routes through Intl for locale-correct
  // grouping (handles Spanish no-group-below-10k and fr-FR NBSP automatically).
  const intFormatted = formatGroupedInteger(intPart, locale)

  let result: string
  if (!hasFraction) {
    result = intFormatted
  } else {
    // Extract fractional digits via string truncation (not rounding).
    // toFixed(7) gives one extra digit for safe slicing; we take the first 6.
    const fixed7 = abs.toFixed(7)
    const allFrac = fixed7.slice(fixed7.indexOf('.') + 1)
    const fracTruncated = allFrac.slice(0, 6)
    result = `${intFormatted}${locale.decimal}${fracTruncated}`
    result = trimTrailingZerosMinTwo(result, locale.decimal)
  }

  return willTruncate ? `${result}…` : result
}

// ---------------------------------------------------------------------------
// Public API — unified entry point
// ---------------------------------------------------------------------------

/**
 * Presentation preset. Encodes the shaping rule AND the currency placement:
 * `fiat*` presets place an ISO symbol via `Intl.NumberFormat` (locale-correct
 * position); `crypto*` presets suffix a free-form ticker with a space.
 * Denomination is not a separate input — it's implied by the preset and (for
 * lossless crypto) by `decimals`.
 *
 * Percentages are intentionally not a preset: every percent surface needs
 * per-call `fractionDigits` / `asPercent` and locale-correct `%` spacing
 * (NBSP in DE/FR/RU), which the knob-less preset API can't express. Use
 * `useFormatPercent()` / `formatPercent` (in `../i18n/number-format`) instead.
 */
export type AmountPreset =
  | 'fiatBalance'
  | 'fiatPrice'
  | 'fiatFee'
  | 'fiatCompact'
  | 'cryptoBalance'
  | 'cryptoActivity'
  | 'cryptoTxDetail'
  | 'cryptoFee'

export type FormatAmountOptions = {
  readonly preset: AmountPreset
  /** ISO 4217 code for `fiat*` presets, token ticker for `crypto*` presets; omit for `percent`. */
  readonly currency?: string | undefined
  readonly locale?: NumberLocale | undefined
  /** Token decimal places — required when `value` is a `bigint`. */
  readonly decimals?: number | undefined
}

const withTicker = (body: string, ticker: string): string => (ticker ? `${body} ${ticker}` : body)

/**
 * The single user-facing number formatter. Pick a {@link AmountPreset}; pass an
 * ISO code (fiat) or ticker (crypto) as `currency`; pass a `bigint` + `decimals`
 * for lossless crypto values or a plain `number` otherwise.
 *
 * For USD-denominated backend data, convert first with `toSettingsFiat` and
 * spread the result:
 *   const {value, currency} = toSettingsFiat(usd, ctx)
 *   formatAmount(value, {preset: 'fiatBalance', currency, locale})
 */
export function formatAmount(value: number | bigint, options: FormatAmountOptions): string {
  const {preset, currency = '', locale = EN_US_NUMBER_LOCALE, decimals} = options
  const num = typeof value === 'bigint' ? bigintToDisplayNumber(value, decimals ?? 0) : value

  switch (preset) {
    case 'fiatBalance':
      return formatFiatBalance(num, currency, locale)
    case 'fiatPrice':
      return formatTokenPrice(num, currency, locale)
    case 'fiatFee':
      return formatNetworkFeeFiat(num, currency, locale)
    case 'fiatCompact':
      return formatFiatCompact(num, currency, locale)
    case 'cryptoBalance':
      return withTicker(formatTokenBalance(num, locale), currency)
    case 'cryptoActivity':
      return withTicker(formatActivityCrypto(num, locale), currency)
    case 'cryptoTxDetail':
      return withTicker(formatTxDetailCrypto(num, locale), currency)
    case 'cryptoFee':
      return withTicker(formatNetworkFeeToken(num, locale), currency)
  }
}
