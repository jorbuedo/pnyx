import {describe, expect, it} from 'vitest'
import {parseSlot, slotBoundMode} from './slot-bound'

const A_DATE = new Date(1_784_501_709 * 1000)

describe('parseSlot', () => {
  it('reads empty as unbounded rather than as zero', () => {
    expect(parseSlot('')).toEqual({ok: true})
    expect(parseSlot('   ')).toEqual({ok: true})
  })

  it('reads a slot number', () => {
    expect(parseSlot('192935418')).toEqual({ok: true, slot: 192_935_418n})
    expect(parseSlot(' 86400 ')).toEqual({ok: true, slot: 86_400n})
    // A slot outruns Number.MAX_SAFE_INTEGER only in theory, but the script
    // field is 64-bit and the value never round-trips through a number.
    expect(parseSlot('9007199254740993')).toEqual({ok: true, slot: 9_007_199_254_740_993n})
  })

  it('refuses anything that is not a plain slot number', () => {
    expect(parseSlot('-1').ok).toBe(false)
    expect(parseSlot('1.5').ok).toBe(false)
    expect(parseSlot('1e6').ok).toBe(false)
    expect(parseSlot('tomorrow').ok).toBe(false)
  })
})

describe('slotBoundMode', () => {
  it('shows the slot number while the anchor is unresolved', () => {
    expect(slotBoundMode(false, '', null)).toBe('slot')
    expect(slotBoundMode(false, '192935418', A_DATE)).toBe('slot')
  })

  it('offers the picker for an empty bound once the anchor is resolved', () => {
    expect(slotBoundMode(true, '', null)).toBe('picker')
    expect(slotBoundMode(true, '  ', null)).toBe('picker')
  })

  it('offers the picker for a bound the anchor can place', () => {
    expect(slotBoundMode(true, '192935418', A_DATE)).toBe('picker')
  })

  it('falls back to the slot number for a bound that does not place', () => {
    // A Byron-era slot, or one typed before the anchor could date it: the picker
    // would show an empty field over a wallet that has a bound.
    expect(slotBoundMode(true, '99', null)).toBe('slot')
    expect(slotBoundMode(true, 'nonsense', null)).toBe('slot')
  })
})
