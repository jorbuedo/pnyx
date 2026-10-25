import {describe, expect, it} from 'vitest'

import {MIN_DISPLAYABLE_DUST_SPECKS, midnightFeeDisplay, speckPerDust} from './fee-display'

describe('midnightFeeDisplay', () => {
  /**
   * The case this module exists for: preprod reported `fee: "1"` for a real transfer, and rendering
   * one speck as DUST said "0 DUST" — a nonzero fee displayed as free.
   */
  it('states a one-speck fee in specks rather than rounding it to zero DUST', () => {
    expect(midnightFeeDisplay(1n)).toEqual({amount: 1n, unit: 'SPECK', decimals: 0})
  })

  it('keeps specks right up to the smallest displayable DUST figure', () => {
    expect(midnightFeeDisplay(MIN_DISPLAYABLE_DUST_SPECKS - 1n).unit).toBe('SPECK')
    expect(midnightFeeDisplay(MIN_DISPLAYABLE_DUST_SPECKS).unit).toBe('DUST')
  })

  it('uses DUST once the figure is legible, rather than fifteen digits of speck', () => {
    const oneDust = speckPerDust()
    expect(midnightFeeDisplay(oneDust)).toEqual({amount: oneDust, unit: 'DUST', decimals: 15})
    expect(midnightFeeDisplay(oneDust * 30_000n).unit).toBe('DUST')
  })

  it('leaves a genuinely zero fee in DUST — "0 DUST" is true there', () => {
    // Switching units for zero would read as a different kind of nothing.
    expect(midnightFeeDisplay(0n)).toEqual({amount: 0n, unit: 'DUST', decimals: 15})
  })

  it('pins the scale at 10^15 specks to one DUST', () => {
    // The sponsor's 30,000 DUST reads as 30000000000000000000 raw, which is this scale.
    expect(speckPerDust()).toBe(1_000_000_000_000_000n)
    expect(30_000n * speckPerDust()).toBe(30_000_000_000_000_000_000n)
  })
})
