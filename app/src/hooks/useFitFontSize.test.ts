import {describe, expect, it} from 'vitest'
import {computeFitFontSize} from './useFitFontSize'

const base = {maxFontSize: 46, minFontSize: 24, widthRatio: 0.6, reserveWidth: 0} as const

describe('computeFitFontSize', () => {
  it('returns the max size before the first measurement', () => {
    expect(computeFitFontSize({...base, chars: 20, availableWidth: null})).toBe(46)
  })

  it('keeps the max size when the string fits with room to spare', () => {
    // "$84.20" (6 chars) at full phone width never needs shrinking.
    expect(computeFitFontSize({...base, chars: 6, availableWidth: 347})).toBe(46)
  })

  it('shrinks proportionally as the digit count grows', () => {
    // budget = 347; floor(347 / (chars * 0.6)), clamped to [24, 46].
    expect(computeFitFontSize({...base, chars: 14, availableWidth: 347})).toBe(41)
    expect(computeFitFontSize({...base, chars: 18, availableWidth: 347})).toBe(32)
    expect(computeFitFontSize({...base, chars: 22, availableWidth: 347})).toBe(26)
  })

  it('clamps to the minimum size for extreme lengths', () => {
    // A 13-digit trillion-plus figure solves below 24; the clamp holds.
    expect(computeFitFontSize({...base, chars: 26, availableWidth: 347})).toBe(24)
    expect(computeFitFontSize({...base, chars: 60, availableWidth: 347})).toBe(24)
  })

  it('shrinks more in a narrower container for the same string', () => {
    const wide = computeFitFontSize({...base, chars: 16, availableWidth: 347})
    const narrow = computeFitFontSize({...base, chars: 16, availableWidth: 200})
    expect(narrow).toBeLessThan(wide)
  })

  it('subtracts reserved sibling width from the budget', () => {
    const noReserve = computeFitFontSize({...base, chars: 16, availableWidth: 347})
    const reserved = computeFitFontSize({...base, chars: 16, availableWidth: 347, reserveWidth: 44})
    expect(reserved).toBeLessThan(noReserve)
  })

  it('never divides by zero on an empty string', () => {
    expect(computeFitFontSize({...base, chars: 0, availableWidth: 347})).toBe(46)
  })
})
