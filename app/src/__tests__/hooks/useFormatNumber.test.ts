import BigNumber from 'bignumber.js'
import {describe, expect, it} from 'vitest'
import {formatNumberValue, getLocaleNumberSymbols, makeLocaleFormat} from '../../i18n/number-format'

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeFormat(locale: string): BigNumber.Format {
  return makeLocaleFormat(locale)
}

// ─── getLocaleNumberSymbols ───────────────────────────────────────────────────

describe('getLocaleNumberSymbols', () => {
  it('returns period decimal and comma group for en-US', () => {
    const {decimal, group} = getLocaleNumberSymbols('en-US')
    expect(decimal).toBe('.')
    expect(group).toBe(',')
  })

  it('returns comma decimal and period group for de', () => {
    const {decimal, group} = getLocaleNumberSymbols('de')
    expect(decimal).toBe(',')
    expect(group).toBe('.')
  })

  it('returns comma decimal for ja-JP (Japanese)', () => {
    const {decimal} = getLocaleNumberSymbols('ja-JP')
    expect(decimal).toBe('.')
  })

  it('falls back to period decimal and comma group for an unknown locale', () => {
    const {decimal, group} = getLocaleNumberSymbols('xx-XX')
    expect(decimal).toBe('.')
    expect(group).toBe(',')
  })
})

// ─── formatNumberValue ────────────────────────────────────────────────────────

describe('formatNumberValue', () => {
  const enFormat = makeFormat('en-US')
  const deFormat = makeFormat('de')

  describe('basic formatting', () => {
    it('formats an integer with group separator', () => {
      expect(formatNumberValue(1234567, enFormat)).toBe('1,234,567')
    })

    it('formats a decimal with locale separators', () => {
      expect(formatNumberValue(1234567.89, enFormat)).toBe('1,234,567.89')
    })

    it('applies German locale separators', () => {
      expect(formatNumberValue(1234567.89, deFormat)).toBe('1.234.567,89')
    })

    it('formats zero', () => {
      expect(formatNumberValue(0, enFormat)).toBe('0')
    })

    it('formats negative numbers', () => {
      expect(formatNumberValue(-1234.5, enFormat)).toBe('-1,234.5')
    })
  })

  describe('BigNumber precision', () => {
    it('handles very large integers without precision loss', () => {
      const large = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
      expect(formatNumberValue(large, enFormat, {noGrouping: true})).toBe(large)
    })

    it('accepts a BigNumber instance directly', () => {
      const bn = new BigNumber('9007199254740993') // beyond Number.MAX_SAFE_INTEGER
      expect(formatNumberValue(bn, enFormat, {noGrouping: true})).toBe('9,007,199,254,740,993'.replace(/,/g, ''))
    })
  })

  describe('decimalPlaces', () => {
    it('truncates to specified decimal places (ROUND_DOWN default)', () => {
      expect(formatNumberValue(1.999, enFormat, {decimalPlaces: 2})).toBe('1.99')
    })

    it('pads with trailing zeros when value has fewer decimals', () => {
      expect(formatNumberValue(1.5, enFormat, {decimalPlaces: 4})).toBe('1.5000')
    })

    it('truncates to 0 decimal places', () => {
      expect(formatNumberValue(9.9, enFormat, {decimalPlaces: 0})).toBe('9')
    })

    it('respects ROUND_HALF_UP when specified', () => {
      expect(formatNumberValue(1.995, enFormat, {decimalPlaces: 2, roundingMode: BigNumber.ROUND_HALF_UP})).toBe('2.00')
    })
  })

  describe('noGrouping', () => {
    it('suppresses group separators when noGrouping is true', () => {
      expect(formatNumberValue(1234567, enFormat, {noGrouping: true})).toBe('1234567')
    })

    it('preserves decimal separator when noGrouping is true', () => {
      expect(formatNumberValue(1234.5, enFormat, {noGrouping: true})).toBe('1234.5')
    })
  })

  describe('prefix and suffix', () => {
    it('prepends a prefix string', () => {
      expect(formatNumberValue(42, enFormat, {prefix: '+'})).toBe('+42')
    })

    it('appends a suffix string', () => {
      expect(formatNumberValue(1.5, enFormat, {decimalPlaces: 2, suffix: ' ADA'})).toBe('1.50 ADA')
    })

    it('applies both prefix and suffix', () => {
      expect(formatNumberValue(100, enFormat, {prefix: '$', suffix: ' USD'})).toBe('$100 USD')
    })
  })

  describe('edge cases', () => {
    it('returns em-dash for NaN', () => {
      expect(formatNumberValue(NaN, enFormat)).toBe('—')
    })

    it('returns em-dash for non-numeric string', () => {
      expect(formatNumberValue('not-a-number', enFormat)).toBe('—')
    })

    it('returns ∞ for positive Infinity', () => {
      expect(formatNumberValue(Infinity, enFormat)).toBe('∞')
    })

    it('returns -∞ for negative Infinity', () => {
      expect(formatNumberValue(-Infinity, enFormat)).toBe('-∞')
    })
  })
})
