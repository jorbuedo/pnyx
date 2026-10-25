import {describe, expect, it} from 'vitest'

import {DOT_CHAR, dotsFor, MAX_DOTS, MIN_DOTS} from './privacy-placeholder'

describe('dotsFor', () => {
  it('returns MIN_DOTS dots for undefined', () => {
    expect(dotsFor(undefined)).toBe(DOT_CHAR.repeat(MIN_DOTS))
  })

  it('returns MIN_DOTS dots for an empty string', () => {
    expect(dotsFor('')).toBe(DOT_CHAR.repeat(MIN_DOTS))
  })

  it('returns MIN_DOTS dots for whitespace-only input', () => {
    expect(dotsFor('   ')).toBe(DOT_CHAR.repeat(MIN_DOTS))
    expect(dotsFor('\t\n')).toBe(DOT_CHAR.repeat(MIN_DOTS))
  })

  it('clamps inputs shorter than MIN_DOTS up to MIN_DOTS', () => {
    expect(dotsFor('a')).toBe(DOT_CHAR.repeat(MIN_DOTS))
    expect(dotsFor('2%')).toBe(DOT_CHAR.repeat(MIN_DOTS))
    expect(dotsFor('abc')).toBe(DOT_CHAR.repeat(MIN_DOTS))
  })

  it('uses the exact visible-char count when within [MIN_DOTS, MAX_DOTS]', () => {
    expect(dotsFor('abcde')).toBe(DOT_CHAR.repeat(5))
    expect(dotsFor('+4.4%')).toBe(DOT_CHAR.repeat(5))
    expect(dotsFor('abcdef')).toBe(DOT_CHAR.repeat(6))
  })

  it('clamps inputs longer than MAX_DOTS down to MAX_DOTS', () => {
    expect(dotsFor('1234567890')).toBe(DOT_CHAR.repeat(MAX_DOTS))
    expect(dotsFor('$12,847.50')).toBe(DOT_CHAR.repeat(MAX_DOTS))
    expect(dotsFor('+$248.30 (1.87%)')).toBe(DOT_CHAR.repeat(MAX_DOTS))
  })

  it('strips whitespace before counting', () => {
    // "0.18 ETH" → 7 visible chars (no whitespace), inside [4, 8]
    expect(dotsFor('0.18 ETH')).toBe(DOT_CHAR.repeat(7))
    // Whitespace at the boundary should not change the count
    expect(dotsFor('  abcde  ')).toBe(DOT_CHAR.repeat(5))
  })

  it('always returns U+2022 (BULLET) characters', () => {
    expect(DOT_CHAR).toBe('•')
    expect(dotsFor('anything')).toMatch(/^•+$/)
  })
})
