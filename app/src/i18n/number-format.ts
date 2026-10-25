/**
 * Locale-aware number formatting and input parsing.
 *
 * Pure — no React or platform dependencies. Safe to import in tests, Effect
 * code, and background sync. React call sites should use the hooks in
 * {@link ../hooks/useFormatNumber} which bind locale from context.
 *
 * Contains three layers:
 * 1. {@link NumberLocale} + {@link resolveNumberLocale} — locale model
 * 2. {@link parseNumberFromText} — user-input parser (TextInput → bigint)
 * 3. {@link formatNumberValue} + {@link makeLocaleFormat} — BigNumber formatter helpers
 *
 * Display formatters (`formatCrypto`, `formatFiat`, `formatPercent`) live in
 * follow-up commits; this module is the shared primitive layer.
 *
 * @module
 */

import BigNumber from 'bignumber.js'
import {FIAT_SYMBOLS} from '../providers/fiat-currencies'
import {decimalStringToBigInt} from '../utils/amount'

// ============================================================================
// Intl.NumberFormat memoization
// ============================================================================

/**
 * `new Intl.NumberFormat(...)` is expensive on Hermes — the constructor parses
 * the locale data and option set every call. Sentry profile
 * `a56ff8b8bfde48149d1454f3940137dc` (low-end Android, card screen) attributed
 * **475ms self time** to `intlNumberFormatConstructor` for a single screen
 * session, almost all of it from `formatLocalizedNumber` / `formatGroupedInteger`
 * — every balance row / fiat label re-constructed a fresh formatter.
 *
 * The unique `(locale, options)` permutations in the app are bounded (~10–30
 * across all screens × supported locales), so a single module-level Map gives
 * an effectively-permanent cache without leaking memory.
 *
 * Keep this helper internal — callers use the format functions below, which
 * route through it transparently.
 */
const numberFormatCache = new Map<string, Intl.NumberFormat>()

export function getNumberFormat(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  // `JSON.stringify` ordering is insertion-order-stable across V8 / Hermes for
  // the small object shapes we pass (≤6 keys, all string/number/boolean).
  // Each call site builds its options object literal in a fixed key order, so
  // identical option sets serialize identically and hit the cache.
  const key = options ? `${locale}|${JSON.stringify(options)}` : locale
  let nf = numberFormatCache.get(key)
  if (!nf) {
    nf = options ? new Intl.NumberFormat(locale, options) : new Intl.NumberFormat(locale)
    numberFormatCache.set(key, nf)
  }
  return nf
}

// ============================================================================
// Types
// ============================================================================

/**
 * Describes the separator conventions for a given locale.
 *
 * Produced by {@link resolveNumberLocale} which probes `Intl.NumberFormat` for
 * the actual characters — callers should not construct this manually except in
 * tests.
 */
export type NumberLocale = {
  /** BCP-47 language tag, e.g. `"en-US"`, `"de-DE"`. */
  readonly tag: string
  /** Decimal separator character, e.g. `"."` or `","`. */
  readonly decimal: string
  /**
   * Thousands / group separator character, e.g. `","`, `"."`, or `" "` (NBSP).
   * Some locales use a narrow NBSP (`" "`).
   */
  readonly group: string
  /** Number of digits in each integer group — always `3` for the locales we support. */
  readonly groupSize: number
}

/**
 * Output of {@link parseNumberFromText}.
 *
 * Four views of the same user input — the upstream-hardened contract:
 *
 * - `inputValue`: what the TextInput.value should render. Locale-correct
 *   decimal separator, no thousands grouping (typing is already hard without
 *   jumping separators), may end in the locale decimal sep mid-typing so
 *   the user can continue adding fractional digits.
 * - `canonicalStr`: `.`-decimal string with no grouping and no trailing
 *   separator. The canonical string form for parent state / route API
 *   calls / `decimalStringToBigInt`. Always parseable by `Number()` /
 *   `BigNumber()`.
 * - `canonical`: atomic-unit bigint (e.g. lovelace for ADA, wei for ETH).
 *   Derived from `canonicalStr` via `decimalStringToBigInt(_, decimals)`,
 *   with fractional digits truncated (never rounded) at `precision`.
 * - `isEmpty`: convenience flag — `true` when the input contained no
 *   meaningful digits (empty string, whitespace, noise-only).
 */
export type ParseNumberResult = {
  readonly inputValue: string
  readonly canonicalStr: string
  readonly canonical: bigint
  readonly isEmpty: boolean
}

// ============================================================================
// Locale resolution
// ============================================================================

/**
 * Extracts the decimal and group separator characters for a given BCP-47 tag.
 *
 * Prefers `Intl.NumberFormat.formatToParts` when the runtime provides it. On
 * Hermes (React Native Android) `formatToParts` is not implemented, so we fall
 * back to formatting `100000.1` and scanning the output directly: the last
 * non-digit character is the decimal separator, and the first non-digit that
 * isn't the decimal is the group separator.
 *
 * Uses `100000.1` as the probe because:
 * - Spanish (`es-ES`) only groups numbers >= 10,000 — probing with a smaller
 *   value returns no group part and forces the fallback.
 * - Six integer digits guarantee at least one group separator in every
 *   locale that groups at all.
 */
export function getLocaleNumberSymbols(locale: string): {decimal: string; group: string} {
  const nf = getNumberFormat(locale)
  if (typeof nf.formatToParts === 'function') {
    const parts = nf.formatToParts(100000.1)
    return {
      decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
      group: parts.find((p) => p.type === 'group')?.value ?? ',',
    }
  }
  // Hermes-Android fallback: scan the formatted string.
  const formatted = nf.format(100000.1)
  let decimalIdx = -1
  for (let i = formatted.length - 1; i >= 0; i--) {
    const ch = formatted[i]
    if (ch !== undefined && !/\d/.test(ch)) {
      decimalIdx = i
      break
    }
  }
  const decimal = decimalIdx >= 0 ? (formatted[decimalIdx] ?? '.') : '.'
  let group = ','
  for (let i = 0; i < decimalIdx; i++) {
    const ch = formatted[i]
    if (ch !== undefined && !/\d/.test(ch) && ch !== decimal) {
      group = ch
      break
    }
  }
  return {decimal, group}
}

/**
 * Resolve a BCP-47 tag to a {@link NumberLocale}.
 *
 * Falls back to `en-US` conventions when Intl doesn't recognise the tag.
 */
export function resolveNumberLocale(tag: string): NumberLocale {
  const {decimal, group} = getLocaleNumberSymbols(tag)
  return {tag, decimal, group, groupSize: 3}
}

/** A hardcoded `en-US` locale — convenient default for tests and fallbacks. */
export const EN_US_NUMBER_LOCALE: NumberLocale = {
  tag: 'en-US',
  decimal: '.',
  group: ',',
  groupSize: 3,
}

// ============================================================================
// bigint ↔ TextInput string (atomic unit aware)
// ============================================================================

/**
 * Convert a bigint atomic-unit value to the locale-correct TextInput string —
 * integer, decimal separator, fractional. No thousands grouping, no symbol.
 * Trailing zeros in the fractional part are stripped so the user can continue
 * typing without fighting a zero-padded display.
 *
 * Works for every chain's precision (6 for ADA / TRX, 8 for BTC, 9 for SOL,
 * 18 for ETH/EVM, 24 for Cosmos variants) — the generic counterpart to
 * {@link parseNumberFromText}'s `canonical` output, closing the loop between
 * bigint atomic state and the TextInput's rendered value.
 *
 * Returns `''` for zero so the placeholder (`"0"`) shows instead of a literal
 * `0` the user has to delete before typing.
 *
 * @example
 * // ADA: 1_500_000n lovelace (decimals=6), en-US → "1.5"
 * // ETH: 1_500_000_000_000_000_000n wei (decimals=18), de-DE → "1,5"
 * // BTC: 100_000_000n sats (decimals=8), fr-FR → "1" (whole BTC)
 * // Zero → "" (TextInput renders the placeholder)
 */
export function bigintToInputString(value: bigint, decimals: number, locale: NumberLocale): string {
  if (value === 0n) return ''
  const negative = value < 0n
  const abs = negative ? -value : value
  if (decimals <= 0) return `${negative ? '-' : ''}${abs}`
  const divisor = 10n ** BigInt(decimals)
  const whole = abs / divisor
  const frac = abs % divisor
  const sign = negative ? '-' : ''
  if (frac === 0n) return `${sign}${whole}`
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${sign}${whole}${locale.decimal}${fracStr}`
}

// ============================================================================
// Low-level: integer grouping that's safe on Hermes
// ============================================================================

/**
 * `Intl.NumberFormat().format(bigint)` is a spec-level ES2020 feature that
 * Hermes (React Native's JS engine) does not implement — it throws
 * `TypeError: Cannot convert BigInt to number` at runtime. This helper is the
 * single entry point for integer grouping across the formatter stack:
 *
 * - `number` input → pass straight to `Intl.NumberFormat` (honors Spanish
 *   "no grouping below 10,000", French NBSP, etc.).
 * - `bigint` within `Number.MAX_SAFE_INTEGER` → coerce to number and use Intl
 *   (which is the overwhelming majority of realistic token balances).
 * - `bigint` beyond safe-integer range → manual grouping using the locale's
 *   group separator. We lose Intl's locale-specific quirks in this branch
 *   (e.g. Spanish's `minimumGroupingDigits`), but we preserve precision and
 *   never crash. This only triggers for balances > ~9e15 integer units.
 */
export function formatGroupedInteger(value: bigint | number, locale: NumberLocale): string {
  if (typeof value === 'number') {
    return getNumberFormat(locale.tag, {maximumFractionDigits: 0}).format(value)
  }
  const abs = value < 0n ? -value : value
  if (abs <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return getNumberFormat(locale.tag, {maximumFractionDigits: 0}).format(Number(value))
  }
  // Beyond safe-integer: manual grouping keyed on the locale's separator so
  // arbitrary-precision bigints (e.g. 10^18 memecoin supply) still render
  // without precision loss.
  const negative = value < 0n
  const digits = abs.toString()
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, locale.group)
  return negative ? `-${grouped}` : grouped
}

// ============================================================================
// Low-level: format a number with min/max fractional digits + locale grouping
// ============================================================================

/**
 * Locale-aware mirror of `formatInvariantNumber` — same `{minFrac, maxFrac}`
 * contract, but uses the given {@link NumberLocale} for decimal and grouping
 * separators and honors locale-specific quirks (Spanish no-group-below-10k,
 * French NBSP spacing) via `Intl.NumberFormat`.
 *
 * Accepts either a `number` (rounded via `toFixed` at `maxFrac`) or a
 * `bigint` paired with `decimals` (rounded losslessly in bigint space). Both
 * paths converge on the shared {@link formatPlain} core, so `formatCrypto`
 * and `formatLocalizedNumber` produce identical output for the same value.
 */
export function formatLocalizedNumber(
  amount: number | bigint,
  options: {
    readonly locale: NumberLocale
    /** Required when `amount` is a `bigint` — ignored for `number`. */
    readonly decimals?: number
    readonly minFrac?: number
    readonly maxFrac?: number
    /**
     * How to handle fractional digits beyond `maxFrac`. Default `'halfUp'`
     * (mirrors Intl.NumberFormat / toFixed). `'truncate'` drops the excess
     * digits — use for balances / rewards where overstating is incorrect.
     */
    readonly rounding?: 'halfUp' | 'truncate'
  },
): string {
  const {locale, decimals = 0, minFrac = 0, maxFrac = 6, rounding = 'halfUp'} = options

  if (typeof amount === 'bigint') {
    const negative = amount < 0n
    const abs = negative ? -amount : amount
    const divisor = 10n ** BigInt(Math.max(decimals, 0))
    const intAbs = abs / divisor
    const fracAbs = abs % divisor
    const body = formatPlain(intAbs, fracAbs, decimals, minFrac, maxFrac, locale, rounding)
    return negative ? `-${body}` : body
  }

  if (!Number.isFinite(amount)) return '0'
  const negative = amount < 0
  const abs = Math.abs(amount)
  // Reduce to a decimal string at exactly `maxFrac` precision, then route
  // through the shared formatPlain core with `decimals === maxFrac` so its
  // rounding step is a no-op (we've already applied the requested rounding).
  // - halfUp: `Number.prototype.toFixed` does half-up at the requested digits.
  // - truncate: `Number.prototype.toFixed(N)` always half-up rounds, and using
  //   it with a high N to "see past" the requested precision surfaces IEEE 754
  //   artifacts (e.g. `(0.29).toFixed(20) === "0.28999…"`), which would then
  //   truncate to "0.28". BigNumber parses floats via their shortest-decimal
  //   `.toString()` representation, so `new BigNumber(0.29)` is exactly `0.29`
  //   and `ROUND_DOWN` gives the lossless truncation we want.
  let fixed = rounding === 'truncate' ? new BigNumber(abs).toFixed(maxFrac, BigNumber.ROUND_DOWN) : abs.toFixed(maxFrac)
  // |abs| ≥ 1e21 makes Number.prototype.toFixed fall back to exponential
  // notation (e.g. `(1.5e21).toFixed(0) === "1.5e+21"`), which then breaks the
  // BigInt() conversions below. BigNumber.toFixed always returns plain decimal.
  if (fixed.includes('e') || fixed.includes('E')) {
    fixed = new BigNumber(abs).toFixed(
      maxFrac,
      rounding === 'truncate' ? BigNumber.ROUND_DOWN : BigNumber.ROUND_HALF_UP,
    )
  }
  const [intStr = '0', fracStrRaw = ''] = fixed.split('.')
  const intAbs = BigInt(intStr)
  const fracAbs = fracStrRaw.length > 0 ? BigInt(fracStrRaw) : 0n
  const body = formatPlain(intAbs, fracAbs, maxFrac, minFrac, maxFrac, locale, rounding)
  return negative ? `-${body}` : body
}

// ============================================================================
// Display formatters — bigint/number → locale-formatted string
// ============================================================================

// Subscript Unicode digits for zero-count compression (0.0₆123 = 6 leading zeros)
const SUBSCRIPT_DIGITS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'] as const

const renderSubscriptDigits = (n: number): string =>
  String(n)
    .split('')
    .map((d) => SUBSCRIPT_DIGITS[Number(d)])
    .join('')

/**
 * Default thresholds for subscript-zero compression.
 * Below these, `formatCrypto`/`formatFiat` render as `0.0ₙXXX` instead of
 * `0.0000…` so the meaningful digits remain visible.
 */
export const SUBSCRIPT_THRESHOLD_CRYPTO = 0.001
export const SUBSCRIPT_THRESHOLD_FIAT = 0.01
export const SUBSCRIPT_SIG_DIGITS_DEFAULT = 3

/**
 * Render a positive decimal string using subscript-zero compression.
 *
 * Operates on the already-lossless decimal string (with `.` as separator) so
 * crypto values with 18+ decimals are never subject to float imprecision.
 *
 * `"0.00000862"` with sigDigits=3, locale.decimal='.' → `"0.0₅862"`
 * (one literal zero after the decimal separator, then the subscript count,
 * then up to `sigDigits` significant digits with trailing zeros trimmed).
 *
 * Callers should gate with a threshold check — this produces compression
 * output even for values where it isn't useful (e.g. `"0.1"` → `"0.1"`).
 */
export function renderSubscriptCompressedFromDecimal(
  decimalStr: string,
  locale: NumberLocale,
  sigDigits: number = SUBSCRIPT_SIG_DIGITS_DEFAULT,
): string {
  const dotIdx = decimalStr.indexOf('.')
  const fracPart = dotIdx === -1 ? '' : decimalStr.slice(dotIdx + 1)

  let leadingZeros = 0
  while (leadingZeros < fracPart.length && fracPart[leadingZeros] === '0') leadingZeros++

  if (fracPart === '' || leadingZeros >= fracPart.length) return `0${locale.decimal}00`

  const significantTail = fracPart.slice(leadingZeros)
  const sigRaw = significantTail.slice(0, sigDigits)
  // Trim trailing zeros but keep at least the first significant digit so we
  // never emit an empty tail (e.g. `"0.00010"` shouldn't collapse to `"0.0₃"`).
  const sig = sigRaw.replace(/0+$/, '') || (significantTail[0] ?? '')

  // Subscript = the TOTAL count of leading zeros after the decimal point, per
  // the Formats guidelines (`0.00000123 → 0.0₅123`) and matching the legacy
  // `formatSubscript`/`formatTokenBalance` output. Below 2 zeros the notation
  // isn't worthwhile — render the zeros literally.
  if (leadingZeros < 2) return `0${locale.decimal}${'0'.repeat(leadingZeros)}${sig}`
  return `0${locale.decimal}0${renderSubscriptDigits(leadingZeros)}${sig}`
}

/**
 * Number-input variant of {@link renderSubscriptCompressedFromDecimal}. Uses
 * `toFixed(20)` internally — fine for fiat values (which are bounded to cents
 * anyway) but callers with bigint precision should use the decimal-string
 * variant directly.
 */
export function renderSubscriptCompressed(
  value: number,
  locale: NumberLocale,
  sigDigits: number = SUBSCRIPT_SIG_DIGITS_DEFAULT,
): string {
  if (!Number.isFinite(value) || value <= 0) return `0${locale.decimal}00`
  return renderSubscriptCompressedFromDecimal(value.toFixed(20), locale, sigDigits)
}

// Intl number-format-part types that together form the number body.
// We swap this contiguous run when rendering subscript notation inside
// currency / compact / percent frames; non-number parts (currency symbol,
// literals, spacing) are preserved verbatim.
const INTL_NUMBER_PART_TYPES: ReadonlySet<Intl.NumberFormatPartTypes> = new Set<Intl.NumberFormatPartTypes>([
  'integer',
  'group',
  'decimal',
  'fraction',
  'minusSign',
  'plusSign',
])

/**
 * Replace the number body of a formatted Intl parts array with a custom body,
 * preserving currency symbols, literal spacing, and compact-notation suffixes.
 *
 * Used to compose subscript-zero rendering inside locale-correct currency
 * frames like `"$X"` (en-US) or `"X €"` (de-DE / fr-FR).
 */
function substituteNumberBody(parts: readonly Intl.NumberFormatPart[], body: string): string {
  let out = ''
  let injected = false
  for (const p of parts) {
    if (INTL_NUMBER_PART_TYPES.has(p.type)) {
      if (!injected) {
        out += body
        injected = true
      }
      // Skip further number parts of the same run; we've replaced them in one shot.
    } else {
      out += p.value
    }
  }
  return out
}

/**
 * Convert a bigint amount in smallest units to a plain decimal string with '.'
 * as the decimal separator. Used as the input to BigNumber for locale-aware
 * formatting so we never lose precision on 18-decimal chains.
 */
function bigintToPlainDecimalString(value: bigint, decimals: number): string {
  if (decimals <= 0) return value.toString()
  const negative = value < 0n
  const abs = negative ? -value : value
  const divisor = 10n ** BigInt(decimals)
  const intPart = (abs / divisor).toString()
  const fracPart = (abs % divisor).toString().padStart(decimals, '0')
  const signed = negative ? `-${intPart}` : intPart
  return `${signed}.${fracPart}`
}

// ---------------------------------------------------------------------------
// formatCrypto
// ---------------------------------------------------------------------------

export type FormatCryptoOptions = {
  readonly decimals: number
  readonly locale: NumberLocale
  /** Token symbol appended with a preceding space (e.g. "1.5 ADA"). */
  readonly symbol?: string
  /** Minimum fractional digits to show. Default 0 (strip trailing zeros). */
  readonly minFractionDigits?: number
  /** Maximum fractional digits to show. Default = `min(decimals, 8)`. */
  readonly maxFractionDigits?: number
  /** Use Intl compact notation (K/M/B / 万/億 / Mio./Mrd. per locale). */
  readonly abbreviate?: boolean
  /** Compact notation kicks in only at or above this magnitude. Default 1_000_000. */
  readonly abbreviateThreshold?: number
  /** Enable subscript-zero compression for values below {@link subscriptThreshold}. */
  readonly subscript?: boolean
  readonly subscriptThreshold?: number
  readonly subscriptSigDigits?: number
  /**
   * Rounding mode for the trailing fractional digits when `maxFractionDigits`
   * is less than `decimals`. Default `'halfUp'` (matches Intl). Use
   * `'truncate'` when the value represents a balance / reward the user owns
   * and the display must not overstate it (e.g. 0.027369 → 0.02, not 0.03).
   * Only applied to the plain locale-format path — compact and subscript
   * compression have their own rounding semantics.
   */
  readonly rounding?: 'halfUp' | 'truncate'
}

/**
 * Format a crypto amount for user-facing display.
 *
 * Composition rules:
 * - `value === 0n` → `"0"` (or `"0 SYMBOL"`) unless `minFractionDigits > 0`.
 * - `abbreviate` + magnitude ≥ `abbreviateThreshold` → Intl compact notation.
 * - `subscript` + 0 < magnitude < `subscriptThreshold` → subscript-zero rendering.
 * - Otherwise: integer via `Intl.NumberFormat` (which honors locale-specific
 *   grouping quirks like Spanish "no grouping below 10k"), fractional via our
 *   own trimming — preserves arbitrary bigint precision in the integer part
 *   and caps fractional digits at `maxFractionDigits` (default `min(decimals, 8)`).
 */
export function formatCrypto(value: bigint, options: FormatCryptoOptions): string {
  const {
    decimals,
    locale,
    symbol,
    minFractionDigits = 0,
    maxFractionDigits = Math.min(decimals, 8),
    abbreviate = false,
    abbreviateThreshold = 1_000_000,
    subscript = false,
    subscriptThreshold = SUBSCRIPT_THRESHOLD_CRYPTO,
    subscriptSigDigits = SUBSCRIPT_SIG_DIGITS_DEFAULT,
    rounding = 'halfUp',
  } = options

  const suffix = symbol ? ` ${symbol}` : ''

  if (value === 0n) {
    const zero = formatPlain(0n, 0n, decimals, minFractionDigits, minFractionDigits, locale)
    return `${zero}${suffix}`
  }

  const negative = value < 0n
  const abs = negative ? -value : value
  const absStr = bigintToPlainDecimalString(abs, decimals)

  // ---- Compact (abbreviated) notation ----
  if (abbreviate) {
    const bn = new BigNumber(absStr)
    const magnitude = bn.toNumber() // Bounded precision acceptable — compact is inherently lossy.
    if (magnitude >= abbreviateThreshold) {
      const formatter = getNumberFormat(locale.tag, {
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: 2,
        minimumFractionDigits: 0,
      })
      const formatted = formatter.format(negative ? -magnitude : magnitude)
      return `${formatted}${suffix}`
    }
  }

  // ---- Subscript-zero compression ----
  if (subscript) {
    // Compare against threshold using the lossless decimal string so we don't
    // mis-gate borderline values due to float imprecision.
    const bn = new BigNumber(absStr)
    if (bn.gt(0) && bn.lt(subscriptThreshold)) {
      const body = renderSubscriptCompressedFromDecimal(absStr, locale, subscriptSigDigits)
      const signed = negative ? `-${body}` : body
      return `${signed}${suffix}`
    }
  }

  // ---- Plain locale-aware format ----
  // Delegate to formatLocalizedNumber so locale handling lives in one place;
  // the bigint overload preserves precision past 2^53 (whale-stake totals).
  const body = formatLocalizedNumber(value, {
    locale,
    decimals,
    minFrac: minFractionDigits,
    maxFrac: maxFractionDigits,
    rounding,
  })
  return `${body}${suffix}`
}

/**
 * Format a positive (or zero) bigint split into integer and fractional parts,
 * using Intl for the integer grouping (so Spanish's "no grouping below 10k"
 * and French NBSP spacing are honored) and manual fractional trimming.
 */
function formatPlain(
  intAbs: bigint,
  fracAbs: bigint,
  decimals: number,
  minFractionDigits: number,
  maxFractionDigits: number,
  locale: NumberLocale,
  rounding: 'halfUp' | 'truncate' = 'halfUp',
): string {
  // Reduce precision in bigint so 1.95 with maxFractionDigits=1 renders as
  // "2.0" under half-up (Intl.NumberFormat / toFixed semantics) or "1.9"
  // under truncate (used for balances / rewards where overstating is wrong).
  // Full bigint precision is preserved through the half-up carry (e.g. 9.95 → 10.0).
  let roundedInt = intAbs
  let roundedFrac = fracAbs
  if (decimals > 0 && maxFractionDigits < decimals) {
    const cap = Math.max(maxFractionDigits, 0)
    const dropDigits = decimals - cap
    const dropDivisor = 10n ** BigInt(dropDigits)
    const fullDivisor = 10n ** BigInt(decimals)
    const total = intAbs * fullDivisor + fracAbs
    const adjusted = rounding === 'halfUp' ? total + dropDivisor / 2n : total
    const rounded = (adjusted / dropDivisor) * dropDivisor
    roundedInt = rounded / fullDivisor
    roundedFrac = rounded % fullDivisor
  }

  // Route through the Hermes-safe helper. Don't pass `useGrouping: true`
  // explicitly — that overrides the locale's `minimumGroupingDigits` (es-ES
  // skips grouping below 10,000, for example). Omitting it lets Intl honor
  // the locale's default convention.
  const intFormatted = formatGroupedInteger(roundedInt, locale)

  if (decimals <= 0 || maxFractionDigits <= 0) {
    return minFractionDigits > 0 ? `${intFormatted}${locale.decimal}${'0'.repeat(minFractionDigits)}` : intFormatted
  }

  let fracStr = roundedFrac.toString().padStart(decimals, '0').slice(0, maxFractionDigits)
  // Pad to minFractionDigits if shorter (needed when fracAbs is 0 and min > 0).
  while (fracStr.length < minFractionDigits) fracStr += '0'
  // Trim trailing zeros above minFractionDigits.
  while (fracStr.length > minFractionDigits && fracStr.endsWith('0')) fracStr = fracStr.slice(0, -1)

  if (fracStr.length === 0) return intFormatted
  return `${intFormatted}${locale.decimal}${fracStr}`
}

// ---------------------------------------------------------------------------
// formatFiat
// ---------------------------------------------------------------------------

/**
 * App-wide currency glyph style. `'narrowSymbol'` keeps the short, locale-
 * neutral mark (`$` not `CA$`/`MX$`, `kr` not `SEK`/`NOK`, `¥` not `CN¥`) so
 * the symbol shown in Settings → Currency is the exact one rendered in
 * balances. Currencies without a narrow glyph (CHF) fall back to their ISO
 * code, same as Intl's default. Every `style: 'currency'` formatter in this
 * module routes through this so the picker and the rendered amount never
 * disagree. Callers may still override per call via `currencyDisplay`.
 */
const DEFAULT_CURRENCY_DISPLAY: Intl.NumberFormatOptions['currencyDisplay'] = 'narrowSymbol'

/**
 * Curated glyph map for every supported fiat. The Settings picker reads from
 * {@link FIAT_SYMBOLS}; routing the formatters through the same table makes
 * the glyph the user picks the same one they see in balances, swap, send,
 * and card surfaces — and makes the resolution deterministic across runtimes.
 *
 * Why curated, not Intl-derived: `Intl.NumberFormat({currencyDisplay: 'narrowSymbol'})`
 * resolves the glyph from ICU. On some Hermes builds (iOS, depending on
 * device region / bundled ICU version), and even on Node V8 for cases like
 * `de-CH` + `EUR`, narrowSymbol falls back to the bare ISO code (`"USD"`,
 * `"EUR"`). The curated map sidesteps that — placement (prefix/suffix) is
 * still read from Intl, so locale conventions are preserved.
 *
 * Non-fiat tickers (token symbols) aren't in the table and fall through to
 * Intl's narrow symbol — the previous behaviour.
 */
const CURRENCY_GLYPH_OVERRIDES: Record<string, string> = FIAT_SYMBOLS

/**
 * Probe an Intl currency formatter at value `0` to find where the currency
 * sits relative to the number (`prefix` / `suffix`) and what whitespace
 * separates them. Value `0` keeps the probe minus-sign-free.
 */
type CurrencyPlacement = {readonly position: 'prefix' | 'suffix'; readonly separator: string}

/**
 * Per-formatter memos for the two Intl reads that are pure functions of the formatter.
 *
 * ⚠️ **Both were being paid on every formatted number.** `resolvedOptions()` builds a fresh options
 * object per call and `formatToParts(0)` builds an array of part objects; measured on a wallet holding
 * 2.13M ADA across three assets, an *idle* home screen spent 84 ms of a 12 s window inside
 * `intlNumberFormatPrototypeResolvedOptions` alone, with `objectDefineProperty`, `Uint8ArrayConstructor`
 * and `GC Young Gen` close behind — allocation churn, on a screen nobody was touching.
 *
 * A `WeakMap` because the formatters come from `numberFormatCache` and are effectively permanent, so
 * this adds no lifetime of its own. The constructor was memoised for the same reason and with the same
 * evidence (see {@link getNumberFormat}); this is the other half of that fix.
 */
const resolvedOptionsCache = new WeakMap<Intl.NumberFormat, Intl.ResolvedNumberFormatOptions>()
const placementCache = new WeakMap<Intl.NumberFormat, CurrencyPlacement>()

/** `nf.resolvedOptions()`, once per formatter. */
const resolvedOptionsOf = (nf: Intl.NumberFormat): Intl.ResolvedNumberFormatOptions => {
  const hit = resolvedOptionsCache.get(nf)
  if (hit !== undefined) return hit
  const resolved = nf.resolvedOptions()
  resolvedOptionsCache.set(nf, resolved)
  return resolved
}

function probeCurrencyPlacement(nf: Intl.NumberFormat): CurrencyPlacement {
  const hit = placementCache.get(nf)
  if (hit !== undefined) return hit
  const computed = computeCurrencyPlacement(nf)
  placementCache.set(nf, computed)
  return computed
}

function computeCurrencyPlacement(nf: Intl.NumberFormat): CurrencyPlacement {
  if (typeof nf.formatToParts !== 'function') return {position: 'prefix', separator: ''}
  const parts = nf.formatToParts(0)
  let numIdx = -1
  let curIdx = -1
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (curIdx === -1 && p.type === 'currency') curIdx = i
    if (numIdx === -1 && INTL_NUMBER_PART_TYPES.has(p.type)) numIdx = i
  }
  if (numIdx < 0 || curIdx < 0) return {position: 'prefix', separator: ''}
  const position = curIdx < numIdx ? 'prefix' : 'suffix'
  const lo = Math.min(numIdx, curIdx)
  const hi = Math.max(numIdx, curIdx)
  let separator = ''
  for (let i = lo + 1; i < hi; i++) {
    const p = parts[i]
    if (p && p.type === 'literal' && /^\s+$/.test(p.value)) separator += p.value
  }
  return {position, separator}
}

/**
 * Wrap a pre-rendered number `body` with the curated `symbol` on the
 * locale-correct side of the number. The leading minus (`sign`) stays outside
 * the currency frame so en-US renders `-$1.50`, not `$-1.50`.
 */
function wrapBodyWithCurrency(body: string, sign: '' | '-', symbol: string, probeNf: Intl.NumberFormat): string {
  const {position, separator} = probeCurrencyPlacement(probeNf)
  return position === 'prefix' ? `${sign}${symbol}${separator}${body}` : `${sign}${body}${separator}${symbol}`
}

/**
 * Render `value` with our curated currency glyph instead of Intl's, keeping
 * locale-correct placement, whitespace separator, fraction defaults, and
 * compact-notation suffix.
 *
 * Why we don't trust `Intl.NumberFormat({style:'currency'})` for the visible
 * symbol: across runtimes and device locales, the same ISO code surfaces in
 * three different `formatToParts` shapes — `[currency:'$']`, `[currency:'US$']`,
 * and (on Hermes-iOS with non-en-US device locales) `[literal:'US',
 * currency:'$']`. The split-literal case is what QA hit: the leading
 * `US` literal leaked past every previous override approach and rendered as
 * `US$0.00` in Swap / Send / Card / Home.
 *
 * The fix: build the visible number body with `style:'decimal'` (so the digits
 * never carry any currency-frame text), pull placement + whitespace separator
 * from a value-0 probe (the only thing we need Intl's currency formatter for),
 * and emit `${sign}${symbol}${separator}${body}` for prefix locales or
 * `${sign}${body}${separator}${symbol}` for suffix locales. Currency-aware
 * fraction defaults (JPY → 0, USD → 2) are inherited from the resolved options
 * of the caller's formatter, so per-currency conventions survive.
 *
 * Exported so the i18n provider's `formatCurrency` shares the same override
 * source as `formatFiat` / `getCurrencySymbol` / the currency picker.
 */
export function formatFiatWithGlyph(nf: Intl.NumberFormat, value: number, currency: string): string {
  const override = CURRENCY_GLYPH_OVERRIDES[currency]
  if (!override) return nf.format(value)
  const resolved = resolvedOptionsOf(nf)
  // Respect explicit code / name display — the caller asked for an ISO code,
  // not a symbol, so the override doesn't apply.
  if (resolved.currencyDisplay === 'code' || resolved.currencyDisplay === 'name') return nf.format(value)

  const decimalOpts: Intl.NumberFormatOptions = {
    style: 'decimal',
    minimumFractionDigits: resolved.minimumFractionDigits,
    maximumFractionDigits: resolved.maximumFractionDigits,
  }
  if (resolved.notation === 'compact') {
    decimalOpts.notation = 'compact'
    decimalOpts.compactDisplay = resolved.compactDisplay ?? 'short'
  }
  const body = getNumberFormat(resolved.locale, decimalOpts).format(Math.abs(value))
  return wrapBodyWithCurrency(body, value < 0 ? '-' : '', override, nf)
}

export type FormatFiatOptions = {
  /** ISO 4217 currency code, e.g. `"USD"`, `"EUR"`, `"JPY"`. */
  readonly currency: string
  readonly locale: NumberLocale
  /** Minimum fractional digits. Default 2 (Intl's per-currency default overrides for zero-decimal currencies like JPY). */
  readonly minFractionDigits?: number
  readonly maxFractionDigits?: number
  readonly currencyDisplay?: Intl.NumberFormatOptions['currencyDisplay']
  readonly abbreviate?: boolean
  readonly abbreviateThreshold?: number
  readonly subscript?: boolean
  readonly subscriptThreshold?: number
  readonly subscriptSigDigits?: number
}

/**
 * Format a fiat amount for user-facing display with locale-correct currency
 * symbol placement.
 */
export function formatFiat(value: number, options: FormatFiatOptions): string {
  const {
    currency,
    currencyDisplay,
    locale,
    minFractionDigits,
    maxFractionDigits,
    abbreviate = false,
    abbreviateThreshold = 1_000_000,
    subscript = false,
    subscriptThreshold = SUBSCRIPT_THRESHOLD_FIAT,
    subscriptSigDigits = SUBSCRIPT_SIG_DIGITS_DEFAULT,
  } = options

  if (!Number.isFinite(value)) return '—'

  // ---- Compact ----
  if (abbreviate && Math.abs(value) >= abbreviateThreshold) {
    const formatter = getNumberFormat(locale.tag, {
      style: 'currency',
      currency,
      currencyDisplay: currencyDisplay ?? DEFAULT_CURRENCY_DISPLAY,
      notation: 'compact',
      compactDisplay: 'short',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
    return formatFiatWithGlyph(formatter, value, currency)
  }

  // ---- Subscript ----
  if (subscript && value > 0 && value < subscriptThreshold) {
    const frame = getNumberFormat(locale.tag, {
      style: 'currency',
      currency,
      currencyDisplay: currencyDisplay ?? DEFAULT_CURRENCY_DISPLAY,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    const body = renderSubscriptCompressed(value, locale, subscriptSigDigits)
    const override = CURRENCY_GLYPH_OVERRIDES[currency]
    if (override) return wrapBodyWithCurrency(body, '', override, frame)
    // No override (unknown currency) — splice the subscript body into Intl's
    // own currency frame. Hermes-Android lacks formatToParts; without it we
    // can't splice, so fall through to plain format.
    if (typeof frame.formatToParts === 'function') {
      return substituteNumberBody(frame.formatToParts(0), body)
    }
  }

  // ---- Plain ----
  const opts: Intl.NumberFormatOptions = {
    style: 'currency',
    currency,
    currencyDisplay: currencyDisplay ?? DEFAULT_CURRENCY_DISPLAY,
  }
  if (minFractionDigits !== undefined) opts.minimumFractionDigits = minFractionDigits
  if (maxFractionDigits !== undefined) opts.maximumFractionDigits = maxFractionDigits
  return formatFiatWithGlyph(getNumberFormat(locale.tag, opts), value, currency)
}

/**
 * The currency glyph Intl uses for a code in a locale (e.g. `'USD'` → `$`,
 * `'CHF'` → `CHF`). Uses the narrow glyph ({@link DEFAULT_CURRENCY_DISPLAY})
 * so this matches what {@link formatFiat} renders. Falls back to the raw code
 * if `formatToParts` is missing (Hermes-Android) or the code is unknown. For
 * placeholder strings like `"$—"` where there's no numeric value to format.
 */
export function getCurrencySymbol(currency: string, locale: NumberLocale): string {
  const override = CURRENCY_GLYPH_OVERRIDES[currency]
  if (override) return override
  const nf = getNumberFormat(locale.tag, {style: 'currency', currency, currencyDisplay: DEFAULT_CURRENCY_DISPLAY})
  if (typeof nf.formatToParts !== 'function') return currency
  return nf.formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency
}

export type CurrencyAffix = {
  readonly symbol: string
  readonly position: 'prefix' | 'suffix'
}

/**
 * The currency glyph plus its locale-correct placement relative to the number
 * (`en-US` USD → `$` prefix; `de-DE` EUR → `€` suffix). For sizing-bound
 * displays — a live-typed hero or a glyph-decorated input — where the number
 * is rendered separately from the symbol and {@link formatFiat}'s single
 * string can't be used directly. Falls back to a prefixed raw code when
 * `formatToParts` is missing (Hermes-Android) or the code is unknown.
 */
export function getCurrencyAffix(currency: string, locale: NumberLocale): CurrencyAffix {
  const override = CURRENCY_GLYPH_OVERRIDES[currency]
  const nf = getNumberFormat(locale.tag, {style: 'currency', currency, currencyDisplay: DEFAULT_CURRENCY_DISPLAY})
  if (typeof nf.formatToParts !== 'function') return {symbol: override ?? currency, position: 'prefix'}
  const parts = nf.formatToParts(0)
  const symbol = override ?? parts.find((p) => p.type === 'currency')?.value ?? currency
  const currencyIdx = parts.findIndex((p) => p.type === 'currency')
  const numberIdx = parts.findIndex((p) => p.type === 'integer')
  const position = currencyIdx >= 0 && numberIdx >= 0 && currencyIdx > numberIdx ? 'suffix' : 'prefix'
  return {symbol, position}
}

// ---------------------------------------------------------------------------
// formatPercent
// ---------------------------------------------------------------------------

export type FormatPercentOptions = {
  readonly locale: NumberLocale
  /** Fractional digits to show. Default 2. */
  readonly fractionDigits?: number
  /**
   * Treat `value` as an already-scaled percent (50 means 50%).
   * Default `false` — follows Intl convention where 0.5 means 50%.
   */
  readonly asPercent?: boolean
}

/**
 * Per-locale separator (empty / regular space / NBSP / narrow NBSP) between the
 * number and `%`. Probed once at `0` — Hermes' `Intl.NumberFormat` percent style
 * has a bug where the percent value gets rounded to whole-integer percent before
 * `minimumFractionDigits` is applied (so `0.0115` formats as `"1.00%"` instead
 * of `"1.15%"`), but `0` formats correctly across runtimes, which is enough to
 * read the locale's spacing convention. See {@link formatPercent}.
 */
const PERCENT_SPACE_CACHE = new Map<string, string>()

function getPercentSpace(localeTag: string): string {
  const cached = PERCENT_SPACE_CACHE.get(localeTag)
  if (cached !== undefined) return cached
  const sample = getNumberFormat(localeTag, {style: 'percent'}).format(0)
  const pctIdx = sample.indexOf('%')
  let i = pctIdx - 1
  while (i >= 0 && !/[0-9]/.test(sample[i] ?? '')) i--
  const space = pctIdx > 0 ? sample.slice(i + 1, pctIdx) : ''
  PERCENT_SPACE_CACHE.set(localeTag, space)
  return space
}

/**
 * Format a percentage with locale-correct decimal separator and spacing before
 * `%` (DE/FR/RU use a non-breaking space; en/JP do not).
 *
 * Avoids two Hermes (React Native's iOS engine) bugs:
 * 1. `Intl.NumberFormat({style: 'percent'})` rounds the percent value to
 *    whole-integer percent before honoring `min/maxFractionDigits` (so `1.15`
 *    rendered as `"1.00%"`). We scale to percent space ourselves and format
 *    the number manually.
 * 2. `BigInt("09")` returns `0n` on some Hermes builds instead of `9n` (leading
 *    zero parsing differs from V8), which would silently turn `"1.09"` into
 *    `"1.00"` if the fractional part flowed through the bigint-based
 *    `formatLocalizedNumber` path. We split the fixed-precision string and
 *    keep the fractional part as a plain string.
 *
 * Locale spacing (NBSP / narrow NBSP / nothing between number and `%`) is
 * probed once via percent style at value `0` — the rounding bug doesn't apply
 * to `0`, so the probe is safe.
 */
export function formatPercent(value: number, options: FormatPercentOptions): string {
  const {locale, fractionDigits = 2, asPercent = false} = options
  if (!Number.isFinite(value)) return '—'
  const percent = asPercent ? value : value * 100
  const sign = percent < 0 ? '-' : ''
  const abs = Math.abs(percent)
  const fixed = abs.toFixed(fractionDigits)
  const dotIdx = fixed.indexOf('.')
  const intStr = dotIdx === -1 ? fixed : fixed.slice(0, dotIdx)
  const fracStr = dotIdx === -1 ? '' : fixed.slice(dotIdx + 1)
  const intFormatted = formatGroupedInteger(Number(intStr), locale)
  const body = fracStr.length > 0 ? `${intFormatted}${locale.decimal}${fracStr}` : intFormatted
  return `${sign}${body}${getPercentSpace(locale.tag)}%`
}

// ============================================================================
// BigNumber helpers (existing — kept for backwards compatibility)
// ============================================================================

/** Builds a {@link BigNumber.Format} descriptor from a BCP-47 tag. */
export function makeLocaleFormat(locale: string): BigNumber.Format {
  const {decimal, group} = getLocaleNumberSymbols(locale)
  return {
    decimalSeparator: decimal,
    groupSeparator: group,
    groupSize: 3,
    secondaryGroupSize: 0,
    fractionGroupSeparator: '',
    fractionGroupSize: 0,
  }
}

/** Builds a {@link BigNumber.Format} descriptor from a {@link NumberLocale}. */
export function numberLocaleToBigNumberFormat(locale: NumberLocale): BigNumber.Format {
  return {
    decimalSeparator: locale.decimal,
    groupSeparator: locale.group,
    groupSize: locale.groupSize,
    secondaryGroupSize: 0,
    fractionGroupSeparator: '',
    fractionGroupSize: 0,
  }
}

export type FormatNumberOptions = {
  /** Number of decimal places to show. Omit to preserve all significant digits. */
  decimalPlaces?: number
  /** Rounding mode (BigNumber.js ROUND_* constant, default ROUND_DOWN). */
  roundingMode?: BigNumber.RoundingMode
  /** Suppress grouping separators (e.g. thousands commas). Default false. */
  noGrouping?: boolean
  /** Prefix string, e.g. '+' or '-'. */
  prefix?: string
  /** Suffix string, e.g. ' ADA'. */
  suffix?: string
}

/**
 * Formats a number value using BigNumber.js with the provided format descriptor.
 *
 * Accepts any value BigNumber.js can parse: `number`, `string`, or `BigNumber`,
 * making it safe for large token amounts that exceed JavaScript's float precision.
 */
export function formatNumberValue(
  value: BigNumber.Value,
  format: BigNumber.Format,
  options: FormatNumberOptions = {},
): string {
  const bn = new BigNumber(value)

  if (bn.isNaN()) return '—'
  if (!bn.isFinite()) return bn.isPositive() ? '∞' : '-∞'

  const fmt: BigNumber.Format = options.noGrouping ? {...format, groupSeparator: ''} : format

  // toFormat(dp, rm, fmt) preserves trailing zeros (e.g. 1.5 → "1.50" with dp=2).
  // toFormat(fmt) alone strips trailing zeros, which is correct when dp is unset.
  const formatted =
    options.decimalPlaces !== undefined
      ? bn.toFormat(options.decimalPlaces, options.roundingMode ?? BigNumber.ROUND_DOWN, fmt)
      : bn.toFormat(fmt)

  return `${options.prefix ?? ''}${formatted}${options.suffix ?? ''}`
}

// ============================================================================
// Input parser
// ============================================================================

// Whitespace that some locales use as a grouping separator: plain space,
// NBSP (U+00A0, fr-FR), narrow NBSP (U+202F, Intl output in some envs).
// Never decimal separators — always grouping; always strip from input.
const WHITESPACE_GROUP_CHARS = /[\s  ]/g

/**
 * When a sanitised input contains N occurrences of the same separator
 * (`.` or `,`), decide whether it's meant to be grouping or a decimal.
 *
 * - N == 1 → always decimal (covers keyboard-locale mismatch too).
 * - N > 1 and every segment after the first is exactly 3 digits → valid
 *   grouping pattern (`"1.234.567"` pasted from DE). Returns `null` so
 *   the caller treats ALL occurrences as grouping and builds canonical
 *   `1234567`.
 * - Otherwise → typo like `"123.45.67"`. Returns the separator so the
 *   LAST occurrence becomes the decimal (consistent with the dual-separator
 *   "last wins" rule) and earlier ones fall into the integer part.
 */
function resolveRepeatedSeparator(sep: '.' | ',', s: string, count: number): '.' | ',' | null {
  if (count === 1) return sep
  const parts = s.split(sep)
  for (let i = 1; i < parts.length; i++) {
    if (!/^\d{3}$/.test(parts[i] ?? '')) return sep
  }
  return null
}

/**
 * Parse a user-supplied number string in a locale-aware way.
 *
 * Handles the upstream-hardened edge cases:
 * - Keyboard/locale mismatch: typed `.` and `,` both map to the locale's
 *   decimal separator when the input contains a single separator of either
 *   kind. User on a DE keyboard typing `1,5` gets the same result as a user
 *   on a US keyboard typing `1.5` when the active locale is DE.
 * - Paste with both separators present: last one wins as decimal,
 *   everything before it is treated as grouping. `"1,234.56"` and
 *   `"1.234,56"` both resolve to the same canonical value regardless of the
 *   active locale.
 * - Paste with one separator repeated: treated as grouping — `"1,234,567"` is
 *   1234567, not a malformed decimal.
 * - Multiple decimal separators: the first is the decimal, later ones are
 *   discarded as noise.
 * - Leading decimal: `.45` is normalised to `0.45` (prepends `"0"`).
 * - Trailing decimal (mid-typing): kept in `inputValue` so the TextInput can
 *   show `"12."`; stripped from `displayValue`.
 * - Precision: fractional digits beyond `precision` (defaults to `decimals`)
 *   are TRUNCATED, never rounded — a wallet must never send more than the
 *   user sees.
 * - Whitespace grouping: space, NBSP (` `), narrow NBSP (` `) are
 *   always treated as grouping and stripped.
 * - Non-digit, non-separator chars (minus sign, currency symbols, letters,
 *   non-Latin digits) are discarded.
 *
 * @param text - Raw input from a TextInput / paste.
 * @param options - Decimals of the target token, active number locale, and
 *   an optional precision cap (defaults to `decimals`).
 */
export function parseNumberFromText(
  text: string,
  options: {
    readonly decimals: number
    readonly locale: NumberLocale
    readonly precision?: number
  },
): ParseNumberResult {
  const {decimals, locale, precision = decimals} = options

  // ---- Step 1: strip to digits + '.' + ',' (whitespace-grouped locales ----
  // use NBSP which is always grouping, so safe to strip early).
  const s = text.replace(WHITESPACE_GROUP_CHARS, '').replace(/[^\d.,]/g, '')

  if (s === '') {
    return {inputValue: '', canonicalStr: '0', canonical: 0n, isEmpty: true}
  }

  // ---- Step 2: determine which char is the decimal separator ----
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  const numDots = (s.match(/\./g) ?? []).length
  const numCommas = (s.match(/,/g) ?? []).length

  // 'dot', 'comma', or 'none' — which char we interpret as the decimal.
  let decimalChar: '.' | ',' | null

  if (numDots > 0 && numCommas > 0) {
    // Both present → position-based. Last one is the decimal; others grouping.
    // This is the cross-locale paste path: `"1,234.56"` and `"1.234,56"`
    // both resolve to the same canonical value regardless of active locale.
    decimalChar = lastDot > lastComma ? '.' : ','
  } else if (numDots > 0 && numCommas === 0) {
    decimalChar = resolveRepeatedSeparator('.', s, numDots)
  } else if (numCommas > 0 && numDots === 0) {
    decimalChar = resolveRepeatedSeparator(',', s, numCommas)
  } else {
    // No separators.
    decimalChar = null
  }

  // ---- Step 3: split into int / frac using the chosen decimal ----
  let intPart: string
  let fracPart: string
  let hasTrailingSep: boolean

  if (decimalChar === null) {
    // All '.' and ',' are grouping noise.
    intPart = s.replace(/[.,]/g, '')
    fracPart = ''
    hasTrailingSep = false
  } else {
    const idx = s.lastIndexOf(decimalChar)
    const before = s.slice(0, idx)
    const after = s.slice(idx + 1)
    // Strip any residual separators from both halves (grouping chars + any
    // stray second decimal in `after` e.g. from paste `"123.45.67"`).
    intPart = before.replace(/[.,]/g, '')
    fracPart = after.replace(/[.,]/g, '')
    hasTrailingSep = fracPart === ''
  }

  // ---- Step 4: prepend 0 for leading decimal; strip redundant leading zeros.
  if (intPart === '') intPart = '0'
  else intPart = intPart.replace(/^0+(?=\d)/, '')

  // ---- Step 5: truncate fractional digits to precision (never round).
  if (fracPart.length > precision) fracPart = fracPart.slice(0, precision)

  // ---- Step 6: build canonical bigint + canonical string.
  const canonicalStr = fracPart ? `${intPart}.${fracPart}` : intPart
  const canonical = decimalStringToBigInt(canonicalStr, decimals)

  // ---- Step 7: build inputValue (for TextInput). Mid-typing trailing decimal
  // is preserved so the user can continue typing; canonicalStr above has
  // already dropped it, so downstream logic sees the clean form.
  const localDec = locale.decimal
  const inputValue =
    fracPart.length > 0 ? `${intPart}${localDec}${fracPart}` : hasTrailingSep ? `${intPart}${localDec}` : intPart

  return {inputValue, canonicalStr, canonical, isEmpty: false}
}
