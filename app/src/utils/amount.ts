/**
 * Pure bigint ↔ decimal-string conversion utilities.
 *
 * These are intentionally free of platform imports (react-native, etc.) so they
 * can be tested directly in Vitest without mocking.
 *
 * @module
 */

/**
 * Convert a plain decimal string (e.g. "1.5") to a bigint in smallest units.
 * Uses pure string/bigint arithmetic — safe for all chains including 18-decimal EVM.
 *
 * The input string must NOT be in scientific notation (e.g. "1e-7") — callers
 * should use `toFixed(decimals)` when converting from `number` before calling this.
 *
 * @example
 * decimalStringToBigInt("1.5", 6)   // 1_500_000n
 * decimalStringToBigInt("100", 6)   // 100_000_000n
 * decimalStringToBigInt("1.0", 18)  // 1_000_000_000_000_000_000n
 */
export function decimalStringToBigInt(value: string, decimals: number): bigint {
  if (!value || value === '.') return 0n
  const [intPart, fracPart = ''] = value.split('.')
  const paddedFrac = fracPart.padEnd(decimals, '0').slice(0, decimals)
  return BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(paddedFrac || '0')
}

/**
 * Convert a bigint amount in smallest units to a plain decimal string.
 * Uses pure bigint arithmetic — safe for all chains including 18-decimal EVM.
 *
 * @example
 * bigIntToDecimalStr(1_500_000n, 6)  // "1.5"
 * bigIntToDecimalStr(1_000_000_000_000_000_000n, 18)  // "1.0" (exactly 1 ETH)
 */
export const bigIntToDecimalStr = (value: bigint, decimals: number): string => {
  if (value === 0n) return '0'
  const divisor = 10n ** BigInt(decimals)
  const intPart = value / divisor
  const fracPart = value % divisor
  if (fracPart === 0n) return intPart.toString()
  const fracStr = fracPart.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${intPart}.${fracStr}`
}

// ---------------------------------------------------------------------------
// UI amount input helpers
// ---------------------------------------------------------------------------

/**
 * Normalize locale-specific decimal/group separators to a plain string with `.`
 * as the decimal separator (for `decimalStringToBigInt` and similar).
 *
 * - `2,22` → `2.22` (decimal comma, common in EU/UA)
 * - `1,234,567` → `1234567` (grouping commas only)
 * - `1.234,56` → `1234.56` (EU grouping + decimal comma)
 * - `1,234.56` → `1234.56` (US grouping + decimal dot)
 *
 * Note: A single comma with three fractional digits (e.g. `1,234` meaning one thousand)
 * is interpreted as decimal `1.234`; users can type `1234` without a separator.
 */
export function normalizeLocaleDecimalInput(raw: string): string {
  const s = raw.replace(/[^0-9.,]/g, '')
  if (s === '') return ''

  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')

  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      const intPart = s.slice(0, lastComma).replace(/\./g, '').replace(/,/g, '')
      const fracPart = s.slice(lastComma + 1).replace(/[^0-9]/g, '')
      return fracPart.length > 0 ? `${intPart || '0'}.${fracPart}` : intPart || '0'
    }
    return s.replace(/,/g, '')
  }

  if (lastComma !== -1 && lastDot === -1) {
    const commaCount = (s.match(/,/g) ?? []).length
    if (commaCount === 1) return s.replace(',', '.')
    return s.replace(/,/g, '')
  }

  return s
}

/** Format an amount string for display, returning '0' for empty/zero values. */
export function formatAmountDisplay(value: string): string {
  if (!value || value === '0') return '0'
  return value
}

/**
 * Strip trailing zeros after the decimal point without corrupting integer values.
 *
 * Safe to call on the output of `toFixed(n)` or `bigIntToDecimalStr`.
 * Unlike `/\.?0+$/`, this regex requires the decimal point to be present
 * before stripping, so integer strings like "100" or "500" are never mutated.
 *
 * @example
 * trimDecimalZeros("1.50000000")   // "1.5"
 * trimDecimalZeros("1.00000000")   // "1"
 * trimDecimalZeros("100.00000000") // "100"
 * trimDecimalZeros("0.00100000")   // "0.001"
 * trimDecimalZeros("100")          // "100"  ← integer preserved
 * trimDecimalZeros("500")          // "500"  ← integer preserved
 */
export function trimDecimalZeros(value: string): string {
  return value.replace(/(\.\d*[1-9])0+$/, '$1').replace(/\.0+$/, '')
}

/**
 * Cap a decimal string to `maxDecimals` places, then strip trailing zeros.
 *
 * Combines the cap regex and `trimDecimalZeros` into a single call to avoid
 * repeating the same two-step pipeline across multiple call sites.
 *
 * @example
 * formatCryptoDisplay("1.123456789012345678") // "1.12345678"
 * formatCryptoDisplay("1.50000000")           // "1.5"
 * formatCryptoDisplay("100")                  // "100"
 */
export function formatCryptoDisplay(value: string, maxDecimals = 8): string {
  const capped = value.replace(new RegExp(`(\\.\\d{${maxDecimals}})\\d+`), '$1')
  return trimDecimalZeros(capped)
}

/** Parse a string to a number, returning 0 for invalid values. */
export function parseAmountInput(value: string): number {
  return parseFloat(value) || 0
}

/**
 * Sanitize decimal input text: allow digits and at most one decimal point,
 * max 2 decimal places, strip leading zeros before non-decimal digits.
 *
 * Returns the sanitized string, or `null` if the input should be rejected
 * (more than one decimal point, more than 2 decimal places).
 */
export function sanitizeDecimalInput(text: string): string | null {
  const cleaned = text.replace(/[^0-9.]/g, '')
  const parts = cleaned.split('.')
  if (parts.length > 2) return null
  if (parts[1] && parts[1].length > 2) return null
  const intPart = (parts[0] ?? '').replace(/^0+(?=\d)/, '') || ''
  return parts.length === 2 ? `${intPart || '0'}.${parts[1] ?? ''}` : intPart
}

// ---------------------------------------------------------------------------
// Safe bigint → fiat conversion helpers
// ---------------------------------------------------------------------------

/** Maximum plausible fiat value for a single transaction ($10 billion). */
const MAX_FIAT_VALUE = 10_000_000_000

/**
 * Convert a bigint amount in smallest units to a human-readable number.
 *
 * Uses pure bigint arithmetic for the integer part and only falls back to
 * floating-point for the fractional remainder, keeping precision loss bounded
 * to sub-cent territory instead of the catastrophic loss that occurs when
 * converting the entire bigint to Number on 18-decimal chains.
 *
 * For UI display, use `formatCrypto` or `formatLocalizedNumber(value, {decimals, ...})`
 * from `../i18n/number-format` — both accept bigint directly and stay
 * lossless. This helper is only for math paths (multiplying by a fiat price
 * etc.) where a JS number is unavoidable.
 */
export function bigintToHumanNumber(value: bigint, decimals: number): number {
  if (decimals <= 0) return Number(value)
  const divisor = 10n ** BigInt(decimals)
  const intPart = value / divisor
  const fracPart = value % divisor
  // Convert parts separately — intPart may still exceed MAX_SAFE_INTEGER for
  // extreme amounts but the fractional contribution stays bounded.
  return Number(intPart) + Number(fracPart) / Number(divisor)
}

/**
 * Validate a computed fiat USD value before rendering.
 *
 * Returns `null` for values that are non-finite, negative, or exceed the
 * sanity threshold — these indicate a data integrity issue upstream
 * (wrong decimals, mismatched price units, etc.) and should be hidden
 * rather than displayed as multi-billion dollar amounts.
 */
export function sanitizeFiatValue(value: number | null): number | null {
  if (value == null) return null
  if (!Number.isFinite(value)) return null
  if (value < 0) return null
  if (value > MAX_FIAT_VALUE) return null
  return value
}
