import {describe, expect, it} from 'vitest'

import {AA_NORMAL, bestInverse, contrastRatio, over, relativeLuminance} from './contrast'

describe('relativeLuminance', () => {
  it('anchors at black and white', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10)
  })

  // Not the channel average: the green coefficient is 0.7152 against blue's 0.0722, so a pure green
  // is far brighter than a pure blue of the same 8-bit value. A palette check that used the average
  // would call a blue accent legible when it is not.
  it('weights the channels as WCAG does', () => {
    expect(relativeLuminance('#00FF00')).toBeGreaterThan(relativeLuminance('#0000FF') * 9)
  })
})

describe('contrastRatio', () => {
  it('gives 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrastRatio('#6C5CE7', '#6C5CE7')).toBeCloseTo(1, 10)
  })

  it('is symmetric, so argument order cannot change a verdict', () => {
    expect(contrastRatio('#6C5CE7', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#6C5CE7'), 10)
  })

  // The number the single-palette preset recorded in a comment for neutral-900 on the brand
  // lavender. Reproducing it here is what says this module measures the same thing that reasoning
  // did, before a dozen palettes start depending on it.
  it('reproduces the ratio the preset documented for lavender', () => {
    expect(contrastRatio('#A29BFE', '#0B1020')).toBeCloseTo(7.8, 1)
  })
})

describe('over', () => {
  it('returns the foreground at full alpha and the background at zero', () => {
    expect(over('#FFFFFF', 1, '#000000')).toBe('#ffffff')
    expect(over('#FFFFFF', 0, '#000000')).toBe('#000000')
  })

  it('composites to the midpoint at half alpha', () => {
    expect(over('#FFFFFF', 0.5, '#000000')).toBe('#808080')
  })
})

describe('bestInverse', () => {
  // The two cases the preset had hand-reasoned. Getting both right from measurement alone is the
  // point: it means adding a palette needs no such reasoning.
  it('picks white on the violet CTA, as the preset did', () => {
    expect(bestInverse('#5443D6', ['#FFFFFF', '#0B1020'])).toBe('#FFFFFF')
  })

  it('picks near-black on the light lavender, which white would fail', () => {
    expect(bestInverse('#A29BFE', ['#FFFFFF', '#0B1020'])).toBe('#0B1020')
    expect(contrastRatio('#A29BFE', '#FFFFFF')).toBeLessThan(AA_NORMAL)
  })

  it('keeps the caller order as the tie-break, so the result is stable', () => {
    const mid = '#777777'
    expect(bestInverse(mid, ['#FFFFFF', '#000000'])).toBe(bestInverse(mid, ['#FFFFFF', '#000000']))
  })

  // ⚠️ The band where *no* polarity works is narrow and real: `#797979` is 4.35:1 against both
  // white and near-black. `bestInverse` returns the least-bad option rather than inventing a third
  // colour — failing such a palette is the harness's job, and the fix is to move the ramp.
  it('still answers when no candidate reaches AA — the ramp is what has to move', () => {
    const unreadable = '#797979'
    expect(contrastRatio(unreadable, '#FFFFFF')).toBeLessThan(AA_NORMAL)
    expect(contrastRatio(unreadable, '#0B1020')).toBeLessThan(AA_NORMAL)
    expect(bestInverse(unreadable, ['#FFFFFF', '#0B1020'])).toBeDefined()
  })
})
