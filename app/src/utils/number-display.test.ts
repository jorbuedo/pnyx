import {describe, expect, it} from 'vitest'
import {formatAmount, SUBSCRIPT_DIGITS} from './number-display'

// ---------------------------------------------------------------------------
// Token Balance
// ---------------------------------------------------------------------------

describe('formatTokenBalance', () => {
  it('returns "0" for zero', () => {
    expect(formatAmount(0, {preset: 'cryptoBalance'})).toBe('0')
  })

  it('formats standard values with max 8 digits / 5 decimals', () => {
    expect(formatAmount(89.87435, {preset: 'cryptoBalance'})).toBe('89.87435')
    expect(formatAmount(0.12552, {preset: 'cryptoBalance'})).toBe('0.12552')
  })

  it('adds thousands separators', () => {
    expect(formatAmount(1034.1455, {preset: 'cryptoBalance'})).toBe('1,034.1455')
    expect(formatAmount(134234.14, {preset: 'cryptoBalance'})).toBe('134,234.14')
  })

  it('reduces decimals as integer part grows (max 8 digits)', () => {
    // 6 integer digits → 2 decimals max
    expect(formatAmount(134234.14, {preset: 'cryptoBalance'})).toBe('134,234.14')
    // 4 integer digits → 4 decimals max (rounds to nearest)
    expect(formatAmount(1034.14556, {preset: 'cryptoBalance'})).toBe('1,034.1456')
  })

  it('abbreviates millions', () => {
    expect(formatAmount(3153839.32, {preset: 'cryptoBalance'})).toBe('3.15M')
    expect(formatAmount(1000000, {preset: 'cryptoBalance'})).toBe('1M')
  })

  it('abbreviates billions', () => {
    expect(formatAmount(30000000000, {preset: 'cryptoBalance'})).toBe('30B')
    expect(formatAmount(12343153839.32, {preset: 'cryptoBalance'})).toBe('12.34B')
  })

  it('uses subscript for values < 0.001', () => {
    // 0.000000123 has 6 leading zeros → 0.0₆123
    expect(formatAmount(0.000000123, {preset: 'cryptoBalance'})).toBe(`0.0${SUBSCRIPT_DIGITS[6]}123`)
    // 0.00012 has 3 leading zeros → 0.0₃12
    expect(formatAmount(0.00012, {preset: 'cryptoBalance'})).toBe(`0.0${SUBSCRIPT_DIGITS[3]}12`)
  })

  it('omits .00 decimals', () => {
    expect(formatAmount(1, {preset: 'cryptoBalance'})).toBe('1')
    expect(formatAmount(100, {preset: 'cryptoBalance'})).toBe('100')
  })

  it('keeps min 2 decimals when not .00', () => {
    expect(formatAmount(1.2, {preset: 'cryptoBalance'})).toBe('1.20')
    expect(formatAmount(0.5, {preset: 'cryptoBalance'})).toBe('0.50')
  })

  it('trims trailing zeros beyond 2nd decimal', () => {
    expect(formatAmount(0.51, {preset: 'cryptoBalance'})).toBe('0.51')
    expect(formatAmount(0.12, {preset: 'cryptoBalance'})).toBe('0.12')
  })

  // Cross-locale behavior (de-DE / fr-FR / ja-JP etc.) is covered in depth by
  // app/src/__tests__/i18n/number-format-locales.test.ts.
})

// ---------------------------------------------------------------------------
// Fiat Balance
// ---------------------------------------------------------------------------

describe('formatFiatBalance', () => {
  it('returns symbol + 0 for zero', () => {
    expect(formatAmount(0, {preset: 'fiatBalance', currency: 'USD'})).toBe('$0')
    expect(formatAmount(0, {preset: 'fiatBalance', currency: 'EUR'})).toBe('€0')
  })

  it('formats standard values with 2 decimals', () => {
    expect(formatAmount(0.13, {preset: 'fiatBalance', currency: 'EUR'})).toBe('€0.13')
    expect(formatAmount(0.12, {preset: 'fiatBalance', currency: 'USD'})).toBe('$0.12')
  })

  it('adds thousands separators', () => {
    expect(formatAmount(1034.14, {preset: 'fiatBalance', currency: 'EUR'})).toBe('€1,034.14')
    expect(formatAmount(134234.14, {preset: 'fiatBalance', currency: 'USD'})).toBe('$134,234.14')
  })

  it('renders sub-cent values as `<{symbol}0.01` instead of subscript compression', () => {
    // Fiat must never use crypto-style subscript-zero compression — the
    // smallest representable amount is 1 cent, anything below collapses to
    // the `<` placeholder.
    expect(formatAmount(0.005, {preset: 'fiatBalance', currency: 'USD'})).toBe('<$0.01')
    expect(formatAmount(0.001, {preset: 'fiatBalance', currency: 'EUR'})).toBe('<€0.01')
    expect(formatAmount(0.00008829, {preset: 'fiatBalance', currency: 'GBP'})).toBe('<£0.01')
  })

  it('abbreviates millions', () => {
    expect(formatAmount(4150000, {preset: 'fiatBalance', currency: 'EUR'})).toBe('€4.15M')
    expect(formatAmount(12120000, {preset: 'fiatBalance', currency: 'USD'})).toBe('$12.12M')
  })

  it('abbreviates exact millions without trailing zeros', () => {
    expect(formatAmount(10000000, {preset: 'fiatBalance', currency: 'USD'})).toBe('$10M')
  })

  it('omits .00 decimals', () => {
    expect(formatAmount(1, {preset: 'fiatBalance', currency: 'EUR'})).toBe('€1')
    expect(formatAmount(100, {preset: 'fiatBalance', currency: 'USD'})).toBe('$100')
  })

  it('keeps min 2 decimals when not .00', () => {
    expect(formatAmount(1.2, {preset: 'fiatBalance', currency: 'USD'})).toBe('$1.20')
  })

  it('no space between symbol and amount in en-US (Intl convention)', () => {
    const result = formatAmount(1034.14, {preset: 'fiatBalance', currency: 'EUR'})
    expect(result).toBe('€1,034.14')
    expect(result).not.toMatch(/€\s/)
  })
})

// ---------------------------------------------------------------------------
// Token Price
// ---------------------------------------------------------------------------

describe('formatTokenPrice', () => {
  it('returns symbol + 0 for zero', () => {
    expect(formatAmount(0, {preset: 'fiatPrice', currency: 'USD'})).toBe('$0')
  })

  it('formats with up to 5 decimals', () => {
    expect(formatAmount(0.00512, {preset: 'fiatPrice', currency: 'EUR'})).toBe('€0.00512')
    expect(formatAmount(0.12552, {preset: 'fiatPrice', currency: 'USD'})).toBe('$0.12552')
    expect(formatAmount(1034.1455, {preset: 'fiatPrice', currency: 'USD'})).toBe('$1,034.1455')
    expect(formatAmount(134234.14, {preset: 'fiatPrice', currency: 'USD'})).toBe('$134,234.14')
    expect(formatAmount(114254.13, {preset: 'fiatPrice', currency: 'GBP'})).toBe('£114,254.13')
  })

  it('uses subscript for small prices', () => {
    // `0.00000123` has 5 leading zeros → subscript ₅ (total-zero count, per the
    // Formats guidelines and `formatTokenBalance`).
    expect(formatAmount(0.00000123, {preset: 'fiatPrice', currency: 'EUR'})).toBe(`€0.0${SUBSCRIPT_DIGITS[5]}123`)
  })

  it('subscript with 6 significant digits', () => {
    expect(formatAmount(0.0000021333494, {preset: 'fiatPrice', currency: 'USD'})).toBe(
      `$0.0${SUBSCRIPT_DIGITS[5]}213334`,
    )
  })

  it('trims trailing zeros with min 2', () => {
    expect(formatAmount(0.0051, {preset: 'fiatPrice', currency: 'EUR'})).toBe('€0.0051')
    expect(formatAmount(0.12, {preset: 'fiatPrice', currency: 'USD'})).toBe('$0.12')
  })

  it('omits .00', () => {
    expect(formatAmount(1, {preset: 'fiatPrice', currency: 'EUR'})).toBe('€1')
  })

  it('keeps min 2 decimals', () => {
    expect(formatAmount(1.2, {preset: 'fiatPrice', currency: 'USD'})).toBe('$1.20')
  })
})

// ---------------------------------------------------------------------------
// Percentage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Network Fee — Fiat
// ---------------------------------------------------------------------------

describe('formatNetworkFeeFiat', () => {
  it('returns symbol + 0 for zero', () => {
    expect(formatAmount(0, {preset: 'fiatFee', currency: 'EUR'})).toBe('€0')
  })

  it('formats with 2 decimals', () => {
    expect(formatAmount(0.36, {preset: 'fiatFee', currency: 'EUR'})).toBe('€0.36')
    expect(formatAmount(12.5, {preset: 'fiatFee', currency: 'USD'})).toBe('$12.50')
  })

  it('shows < for values under 0.01', () => {
    expect(formatAmount(0.005, {preset: 'fiatFee', currency: 'EUR'})).toBe('<€0.01')
  })
})

// ---------------------------------------------------------------------------
// Network Fee — Token
// ---------------------------------------------------------------------------

describe('formatNetworkFeeToken', () => {
  it('returns "0" for zero', () => {
    expect(formatAmount(0, {preset: 'cryptoFee'})).toBe('0')
  })

  it('formats with max 8 digits, no subscript', () => {
    expect(formatAmount(0.000123, {preset: 'cryptoFee'})).toBe('0.000123')
    expect(formatAmount(1.2345678, {preset: 'cryptoFee'})).toBe('1.2345678')
  })

  it('keeps min 2 decimals', () => {
    expect(formatAmount(0.5, {preset: 'cryptoFee'})).toBe('0.50')
  })
})

// ---------------------------------------------------------------------------
// Activity Crypto
// ---------------------------------------------------------------------------

describe('formatActivityCrypto', () => {
  it('returns "0" for zero', () => {
    expect(formatAmount(0, {preset: 'cryptoActivity'})).toBe('0')
  })

  it('abbreviates over 1M', () => {
    expect(formatAmount(3153839.32, {preset: 'cryptoActivity'})).toBe('3.15M')
    expect(formatAmount(30000000000, {preset: 'cryptoActivity'})).toBe('30B')
  })

  it('uses subscript for small values', () => {
    expect(formatAmount(0.000000123, {preset: 'cryptoActivity'})).toBe(`0.0${SUBSCRIPT_DIGITS[6]}123`)
  })

  it('formats standard values with max 8 digits / 6 decimals', () => {
    expect(formatAmount(1234.5678, {preset: 'cryptoActivity'})).toBe('1,234.5678')
  })
})

// ---------------------------------------------------------------------------
// Tx Detail Crypto
// ---------------------------------------------------------------------------

describe('formatTxDetailCrypto', () => {
  it('returns "0" for zero', () => {
    expect(formatAmount(0, {preset: 'cryptoTxDetail'})).toBe('0')
  })

  it('uses subscript for small values', () => {
    expect(formatAmount(0.000000123, {preset: 'cryptoTxDetail'})).toBe(`0.0${SUBSCRIPT_DIGITS[6]}123`)
  })

  it('appends ellipsis when truncating beyond 6 decimals', () => {
    expect(formatAmount(1.123456789, {preset: 'cryptoTxDetail'})).toBe('1.123456\u2026')
  })

  it('does not append ellipsis for values within 6 decimals', () => {
    expect(formatAmount(1234.56, {preset: 'cryptoTxDetail'})).toBe('1,234.56')
    expect(formatAmount(1.1234, {preset: 'cryptoTxDetail'})).toBe('1.1234')
  })

  it('omits .00', () => {
    expect(formatAmount(1, {preset: 'cryptoTxDetail'})).toBe('1')
  })

  it('handles large integers without spurious ellipsis', () => {
    expect(formatAmount(1000000000000000, {preset: 'cryptoTxDetail'})).toBe('1,000,000,000,000,000')
    expect(formatAmount(999999, {preset: 'cryptoTxDetail'})).toBe('999,999')
  })

  it('handles negative small values with subscript', () => {
    expect(formatAmount(-0.000000123, {preset: 'cryptoTxDetail'})).toBe(`-0.0${SUBSCRIPT_DIGITS[6]}123`)
  })

  it('handles negative values normally', () => {
    expect(formatAmount(-1234.56, {preset: 'cryptoTxDetail'})).toBe('-1,234.56')
  })
})

// ---------------------------------------------------------------------------
// formatAmount — unified entry point
// ---------------------------------------------------------------------------

describe('formatAmount', () => {
  it('dispatches fiat presets with Intl currency placement', () => {
    expect(formatAmount(1234.56, {preset: 'fiatBalance', currency: 'USD'})).toBe('$1,234.56')
    expect(formatAmount(0.005, {preset: 'fiatBalance', currency: 'USD'})).toBe('<$0.01')
    expect(formatAmount(0.00512, {preset: 'fiatPrice', currency: 'EUR'})).toBe('€0.00512')
    expect(formatAmount(0.005, {preset: 'fiatFee', currency: 'EUR'})).toBe('<€0.01')
    expect(formatAmount(1500, {preset: 'fiatCompact', currency: 'USD'})).toBe('$1.5K')
  })

  it('suffixes the ticker for crypto presets', () => {
    expect(formatAmount(1034.1455, {preset: 'cryptoBalance', currency: 'ETH'})).toBe('1,034.1455 ETH')
    expect(formatAmount(3153839.32, {preset: 'cryptoActivity', currency: 'ADA'})).toBe('3.15M ADA')
    // No ticker → bare number.
    expect(formatAmount(1234.56, {preset: 'cryptoBalance'})).toBe('1,234.56')
  })

  it('accepts bigint + decimals for crypto values', () => {
    // 1_500_000n at decimals=6 = 1.5
    expect(formatAmount(1_500_000n, {preset: 'cryptoBalance', currency: 'ADA', decimals: 6})).toBe('1.50 ADA')
  })
})
