import {describe, expect, it} from 'vitest'
import {normalizeLocaleDecimalInput} from '../../utils/amount'

describe('normalizeLocaleDecimalInput', () => {
  it('maps a single decimal comma to dot', () => {
    expect(normalizeLocaleDecimalInput('2,22')).toBe('2.22')
    expect(normalizeLocaleDecimalInput('0,5')).toBe('0.5')
  })

  it('strips grouping commas when there is no dot', () => {
    expect(normalizeLocaleDecimalInput('1,234,567')).toBe('1234567')
  })

  it('handles EU grouping with decimal comma', () => {
    expect(normalizeLocaleDecimalInput('1.234,56')).toBe('1234.56')
  })

  it('handles US grouping with decimal dot', () => {
    expect(normalizeLocaleDecimalInput('1,234.56')).toBe('1234.56')
  })

  it('passes through plain digits and dot', () => {
    expect(normalizeLocaleDecimalInput('12.34')).toBe('12.34')
    expect(normalizeLocaleDecimalInput('100')).toBe('100')
  })

  it('strips non-numeric characters', () => {
    expect(normalizeLocaleDecimalInput('12abc,34')).toBe('12.34')
  })

  it('returns empty for empty or non-numeric input', () => {
    expect(normalizeLocaleDecimalInput('')).toBe('')
    expect(normalizeLocaleDecimalInput('   ')).toBe('')
    expect(normalizeLocaleDecimalInput('abc')).toBe('')
  })
})
