/**
 * Unit tests for the display formatters: formatCrypto, formatFiat, formatPercent,
 * and the renderSubscriptCompressed helper.
 *
 * Behavior tests in this file pin to en-US; cross-locale coverage lives in
 * {@link ./number-format-locales.test.ts}.
 */

import {describe, expect, it} from 'vitest'
import {
  EN_US_NUMBER_LOCALE,
  formatCrypto,
  formatFiat,
  formatGroupedInteger,
  formatLocalizedNumber,
  formatPercent,
  type NumberLocale,
  renderSubscriptCompressed,
  SUBSCRIPT_THRESHOLD_CRYPTO,
  SUBSCRIPT_THRESHOLD_FIAT,
} from '../../i18n/number-format'

const EN_US = EN_US_NUMBER_LOCALE
const DE_DE: NumberLocale = {tag: 'de-DE', decimal: ',', group: '.', groupSize: 3}

describe('renderSubscriptCompressed', () => {
  it('compresses value with 7 leading zeros (0.0000000862 → 0.0₇862)', () => {
    // Subscript is the total leading-zero count (Formats guidelines convention).
    expect(renderSubscriptCompressed(0.0000000862, EN_US)).toBe('0.0₇862')
  })

  it('compresses value with 2 leading zeros (0.001 → 0.0₂1)', () => {
    expect(renderSubscriptCompressed(0.001, EN_US)).toBe('0.0₂1')
  })

  it('no compression when only 1 leading zero (0.05 → 0.05)', () => {
    expect(renderSubscriptCompressed(0.05, EN_US)).toBe('0.05')
  })

  it('no compression when value >= 0.1 (0.5 → 0.5)', () => {
    // leadingZeros=0 → render "0.5"
    expect(renderSubscriptCompressed(0.5, EN_US)).toBe('0.5')
  })

  it('trims trailing zeros within sig digits', () => {
    // 0.00001 → 4 leading zeros → ₄, sigRaw="100" trimmed → "1"
    expect(renderSubscriptCompressed(0.00001, EN_US)).toBe('0.0₄1')
  })

  it('uses locale decimal separator (DE)', () => {
    // 0.0000000862 → 7 leading zeros → ₇
    expect(renderSubscriptCompressed(0.0000000862, DE_DE)).toBe('0,0₇862')
  })

  it('returns "0{sep}00" for 0 / NaN / non-positive', () => {
    expect(renderSubscriptCompressed(0, EN_US)).toBe('0.00')
    expect(renderSubscriptCompressed(Number.NaN, EN_US)).toBe('0.00')
    expect(renderSubscriptCompressed(-0.001, EN_US)).toBe('0.00')
  })

  it('respects custom sigDigits', () => {
    // 0.00012345 → 3 leading zeros → ₃, sig digits capped by the arg
    expect(renderSubscriptCompressed(0.00012345, EN_US, 2)).toBe('0.0₃12')
    expect(renderSubscriptCompressed(0.00012345, EN_US, 4)).toBe('0.0₃1234')
  })

  it('handles subscript counts >= 10 with multi-digit subscript', () => {
    // 1e-12 → 11 leading zeros then "1" → subscript ₁₁
    expect(renderSubscriptCompressed(1e-12, EN_US)).toBe('0.0₁₁1')
  })
})

describe('formatCrypto — zero', () => {
  it('renders zero with no minimum decimals', () => {
    expect(formatCrypto(0n, {decimals: 6, locale: EN_US})).toBe('0')
  })

  it('renders zero with symbol', () => {
    expect(formatCrypto(0n, {decimals: 6, locale: EN_US, symbol: 'ADA'})).toBe('0 ADA')
  })

  it('renders zero with minFractionDigits', () => {
    expect(formatCrypto(0n, {decimals: 6, locale: EN_US, minFractionDigits: 2})).toBe('0.00')
  })
})

describe('formatCrypto — plain format', () => {
  it('integer values with grouping', () => {
    expect(formatCrypto(1_234_000_000n, {decimals: 6, locale: EN_US})).toBe('1,234')
  })

  it('fractional values', () => {
    expect(formatCrypto(1_500_000n, {decimals: 6, locale: EN_US})).toBe('1.5')
  })

  it('with symbol', () => {
    expect(formatCrypto(1_500_000n, {decimals: 6, locale: EN_US, symbol: 'ADA'})).toBe('1.5 ADA')
  })

  it('negative values', () => {
    expect(formatCrypto(-1_500_000n, {decimals: 6, locale: EN_US})).toBe('-1.5')
  })

  it('caps at maxFractionDigits (default 8)', () => {
    // 18-decimal ETH value: 1.234567890123456789 → capped at 8 decimals
    expect(
      formatCrypto(1_234_567_890_123_456_789n, {
        decimals: 18,
        locale: EN_US,
      }),
    ).toBe('1.23456789')
  })

  it('rounds (half-up) when maxFractionDigits truncates digits', () => {
    // 1.95 ADA with 1 fractional digit → "2.0", not "1.9". Matches
    // Intl.NumberFormat / toFixed semantics, so staking earnings labels and
    // similar reduced-precision displays don't visibly drift.
    expect(formatCrypto(1_950_000n, {decimals: 6, locale: EN_US, minFractionDigits: 1, maxFractionDigits: 1})).toBe(
      '2.0',
    )
    // Carry through the integer boundary: 9.95 → "10.0".
    expect(formatCrypto(9_950_000n, {decimals: 6, locale: EN_US, minFractionDigits: 1, maxFractionDigits: 1})).toBe(
      '10.0',
    )
    // Round-to-integer (maxFractionDigits = 0) on a value that should round up.
    expect(formatCrypto(1_500_000n, {decimals: 6, locale: EN_US, maxFractionDigits: 0})).toBe('2')
    // Round-down case: 1.94 → "1.9".
    expect(formatCrypto(1_940_000n, {decimals: 6, locale: EN_US, minFractionDigits: 1, maxFractionDigits: 1})).toBe(
      '1.9',
    )
  })

  it('preserves minFractionDigits', () => {
    expect(formatCrypto(1_500_000n, {decimals: 6, locale: EN_US, minFractionDigits: 4})).toBe('1.5000')
  })

  it('trims trailing zeros down to minFractionDigits', () => {
    // value = 1.500000 with max=8, min=2 → "1.50"
    expect(formatCrypto(1_500_000n, {decimals: 6, locale: EN_US, minFractionDigits: 2, maxFractionDigits: 8})).toBe(
      '1.50',
    )
  })

  it('huge 18-decimal values maintain precision', () => {
    // 1234.56789 ETH as wei
    const wei = 1_234_567_890_000_000_000_000n
    expect(formatCrypto(wei, {decimals: 18, locale: EN_US})).toBe('1,234.56789')
  })
})

describe('formatCrypto — abbreviate', () => {
  it('1M+ values use compact notation', () => {
    expect(formatCrypto(1_500_000_000_000n, {decimals: 6, locale: EN_US, abbreviate: true})).toBe('1.5M')
  })

  it('below threshold does not abbreviate', () => {
    expect(formatCrypto(999_999_000_000n, {decimals: 6, locale: EN_US, abbreviate: true})).toBe('999,999')
  })

  it('billions', () => {
    expect(formatCrypto(2_500_000_000_000_000n, {decimals: 6, locale: EN_US, abbreviate: true})).toBe('2.5B')
  })

  it('with symbol', () => {
    expect(formatCrypto(1_500_000_000_000n, {decimals: 6, locale: EN_US, abbreviate: true, symbol: 'ADA'})).toBe(
      '1.5M ADA',
    )
  })

  it('custom threshold kicks in below the default 1M', () => {
    // 5_000_000_000n at decimals=6 = 5000 ADA — would not abbreviate with default 1M threshold
    expect(
      formatCrypto(5_000_000_000n, {
        decimals: 6,
        locale: EN_US,
        abbreviate: true,
        abbreviateThreshold: 1_000,
      }),
    ).toBe('5K')
  })
})

describe('formatCrypto — subscript', () => {
  it('below subscript threshold renders subscript form', () => {
    // 10_000_000_000n at decimals=18 = 0.00000001 — 7 leading zeros → ₇
    expect(formatCrypto(10_000_000_000n, {decimals: 18, locale: EN_US, subscript: true})).toBe('0.0₇1')
  })

  it('at threshold does not use subscript', () => {
    // 0.001 ADA = 1_000n with decimals=6 → plain format
    expect(formatCrypto(1_000n, {decimals: 6, locale: EN_US, subscript: true})).toBe('0.001')
  })

  it('just below threshold uses subscript with precise decimal string', () => {
    // 900n at decimals=6 = 0.0009 — 3 leading zeros → ₃, sigDigits=3 → "0.0₃9"
    // Critical: this test catches the float-imprecision regression where
    // 0.0009.toFixed(20) = "0.00089999999..." would produce "0.0₃899".
    expect(formatCrypto(900n, {decimals: 6, locale: EN_US, subscript: true})).toBe('0.0₃9')
  })

  it('with symbol', () => {
    expect(formatCrypto(10_000_000_000n, {decimals: 18, locale: EN_US, subscript: true, symbol: 'ETH'})).toBe(
      '0.0₇1 ETH',
    )
  })

  it('subscript disabled → plain format capped at 8 decimals', () => {
    // 10_000_000_000n at decimals=18 = 0.00000001 — exactly at 8 decimal cap
    expect(formatCrypto(10_000_000_000n, {decimals: 18, locale: EN_US, subscript: false})).toBe('0.00000001')
    // 1_000_000_000_000n at decimals=18 = 0.000001 — fits within 8 decimals
    expect(formatCrypto(1_000_000_000_000n, {decimals: 18, locale: EN_US, subscript: false})).toBe('0.000001')
  })
})

describe('formatFiat — basic', () => {
  it('USD in en-US', () => {
    expect(formatFiat(1234.5, {currency: 'USD', locale: EN_US})).toBe('$1,234.50')
  })

  it('zero', () => {
    expect(formatFiat(0, {currency: 'USD', locale: EN_US})).toBe('$0.00')
  })

  it('negative values', () => {
    expect(formatFiat(-1234.5, {currency: 'USD', locale: EN_US})).toBe('-$1,234.50')
  })

  it('non-finite returns em-dash', () => {
    expect(formatFiat(Number.NaN, {currency: 'USD', locale: EN_US})).toBe('—')
    expect(formatFiat(Number.POSITIVE_INFINITY, {currency: 'USD', locale: EN_US})).toBe('—')
  })
})

describe('formatFiat — abbreviate', () => {
  it('1M+ uses compact', () => {
    expect(formatFiat(1_500_000, {currency: 'USD', locale: EN_US, abbreviate: true})).toBe('$1.5M')
  })

  it('below threshold does not abbreviate', () => {
    expect(formatFiat(999_999, {currency: 'USD', locale: EN_US, abbreviate: true})).toBe('$999,999.00')
  })
})

describe('formatFiat — subscript', () => {
  it('below threshold renders subscript with currency frame', () => {
    // 0.0000000862 USD — 7 leading zeros → ₇
    const r = formatFiat(0.0000000862, {currency: 'USD', locale: EN_US, subscript: true})
    expect(r).toBe('$0.0₇862')
  })

  it('at threshold does not use subscript', () => {
    expect(formatFiat(0.01, {currency: 'USD', locale: EN_US, subscript: true})).toBe('$0.01')
  })
})

describe('formatPercent', () => {
  it('decimal input (0.5 → 50%)', () => {
    expect(formatPercent(0.5, {locale: EN_US})).toBe('50.00%')
  })

  it('asPercent=true (50 → 50%)', () => {
    expect(formatPercent(50, {locale: EN_US, asPercent: true})).toBe('50.00%')
  })

  it('negative', () => {
    expect(formatPercent(-0.0123, {locale: EN_US})).toBe('-1.23%')
  })

  it('custom fractionDigits', () => {
    expect(formatPercent(0.1234, {locale: EN_US, fractionDigits: 4})).toBe('12.3400%')
    expect(formatPercent(0.1234, {locale: EN_US, fractionDigits: 0})).toBe('12%')
  })

  it('non-finite returns em-dash', () => {
    expect(formatPercent(Number.NaN, {locale: EN_US})).toBe('—')
  })

  // Hermes (React Native iOS) bug: `Intl.NumberFormat({style: 'percent', minimumFractionDigits: 2})`
  // rounds the percent value to whole-integer percent before honoring the fraction
  // digits, so `0.0115` (1.15%) formats as `"1.00%"`. Pin the contract that we
  // scale to percent space ourselves and route through `formatLocalizedNumber`,
  // so the fractional part survives across runtimes.
  it('preserves fractional percent across runtimes (Hermes bug regression)', () => {
    expect(formatPercent(1.15, {locale: EN_US, asPercent: true, fractionDigits: 2})).toBe('1.15%')
    expect(formatPercent(0.0042, {locale: EN_US, fractionDigits: 2})).toBe('0.42%')
  })
})

// Hermes (React Native's engine) doesn't implement `Intl.NumberFormat.format(bigint)`
// and crashes with `TypeError: Cannot convert BigInt to number`. The entire
// formatter stack has to route bigint grouping through `formatGroupedInteger`
// (which coerces to Number when safe, manual grouping when not). These tests
// pin that contract so a future refactor can't reintroduce a bare `.format(bigint)`.
describe('formatGroupedInteger — Hermes-safe bigint grouping', () => {
  it('groups a safe-integer bigint without throwing', () => {
    expect(formatGroupedInteger(1_234_567n, EN_US)).toBe('1,234,567')
  })

  it('groups a bigint beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
    // 10^18 exceeds MAX_SAFE_INTEGER (≈9e15) — Intl/BigInt path would crash on Hermes;
    // we fall back to manual grouping keyed on the locale separator.
    expect(formatGroupedInteger(1_000_000_000_000_000_000n, EN_US)).toBe('1,000,000,000,000,000,000')
  })

  it('handles negative bigint', () => {
    expect(formatGroupedInteger(-1_234_567n, EN_US)).toBe('-1,234,567')
  })

  it('accepts plain numbers', () => {
    expect(formatGroupedInteger(1234567, EN_US)).toBe('1,234,567')
  })

  it('formatLocalizedNumber and formatCrypto no longer crash on large bigints', () => {
    // Regression: `formatLocalizedNumber` and `formatCrypto` both used to call
    // `Intl.NumberFormat().format(BigInt(...))` which throws on Hermes.
    expect(() => formatLocalizedNumber(123.45, {locale: EN_US, minFrac: 2, maxFrac: 2})).not.toThrow()
    expect(() => formatCrypto(1_000_000_000_000_000_000n, {decimals: 0, locale: EN_US})).not.toThrow()
  })
})

describe('exported constants', () => {
  it('SUBSCRIPT_THRESHOLD_CRYPTO is 0.001', () => {
    expect(SUBSCRIPT_THRESHOLD_CRYPTO).toBe(0.001)
  })

  it('SUBSCRIPT_THRESHOLD_FIAT is 0.01', () => {
    expect(SUBSCRIPT_THRESHOLD_FIAT).toBe(0.01)
  })
})
