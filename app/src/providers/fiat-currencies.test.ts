import {describe, expect, it} from 'vitest'

import {FIAT_CURRENCIES, FIAT_CURRENCY_BY_CODE, FIAT_CURRENCY_CODES, FIAT_SYMBOLS} from './fiat-currencies'

describe('FIAT_CURRENCIES table', () => {
  it('has exactly one entry per code', () => {
    const codes = FIAT_CURRENCIES.map((c) => c.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('covers the 15 wallet display currencies', () => {
    expect(FIAT_CURRENCIES.map((c) => c.code).sort()).toEqual(
      ['AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'INR', 'JPY', 'KRW', 'MXN', 'NOK', 'SEK', 'SGD', 'USD'].sort(),
    )
  })

  it('every entry has a non-empty label and symbol', () => {
    for (const entry of FIAT_CURRENCIES) {
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.symbol.length).toBeGreaterThan(0)
    }
  })
})

describe('FIAT_SYMBOLS derived map', () => {
  it('reflects every code in the source table', () => {
    for (const entry of FIAT_CURRENCIES) {
      expect(FIAT_SYMBOLS[entry.code]).toBe(entry.symbol)
    }
  })

  it('returns the well-known glyphs for the popular currencies', () => {
    expect(FIAT_SYMBOLS.USD).toBe('$')
    expect(FIAT_SYMBOLS.EUR).toBe('€')
    expect(FIAT_SYMBOLS.GBP).toBe('£')
    expect(FIAT_SYMBOLS.JPY).toBe('¥')
    expect(FIAT_SYMBOLS.KRW).toBe('₩')
  })
})

describe('FIAT_CURRENCY_CODES', () => {
  it('lists the same codes as FIAT_CURRENCIES, in source order', () => {
    expect(FIAT_CURRENCY_CODES).toEqual(FIAT_CURRENCIES.map((c) => c.code))
  })
})

describe('FIAT_CURRENCY_BY_CODE lookup', () => {
  it('returns the matching entry by ISO code', () => {
    expect(FIAT_CURRENCY_BY_CODE.USD).toEqual({code: 'USD', label: 'US Dollar', symbol: '$'})
    expect(FIAT_CURRENCY_BY_CODE.BRL).toEqual({code: 'BRL', label: 'Brazilian Real', symbol: 'R$'})
  })
})
