import {describe, expect, it} from 'vitest'

import {AA_NORMAL, contrastRatio, relativeLuminance} from './contrast'
import {hexFromOklch, oklchFromHex} from './oklch'

const VIOLET_500 = '#6C5CE7'
const CTA_600 = '#5443D6'

describe('oklch round-trip', () => {
  it('returns the same hex it was given', () => {
    expect(hexFromOklch(oklchFromHex(VIOLET_500))).toBe(VIOLET_500)
  })

  it('round-trips the greys, where chroma is zero', () => {
    for (const hex of ['#000000', '#FFFFFF', '#808080', '#0B1020']) {
      expect(hexFromOklch(oklchFromHex(hex))).toBe(hex.toUpperCase())
    }
  })
})

describe('rotating hue', () => {
  // The whole reason this module exists instead of HSL. Same L and C, every hue: perceived
  // lightness holds, so contrast against white barely moves — which is what makes one set of
  // inverse-colour decisions safe for every palette.
  it('holds luminance roughly constant across the wheel', () => {
    const {l, c} = oklchFromHex(VIOLET_500)
    const luminances = Array.from({length: 12}, (_, i) => relativeLuminance(hexFromOklch({l, c, h: i * 30})))
    const spread = Math.max(...luminances) - Math.min(...luminances)
    expect(spread).toBeLessThan(0.06)
  })

  // ⚠️ The assertion that matters is the *verdict*, not the spread. `primary600` is the CTA fill and
  // carries white text, so white must clear AA at every hue — measured 5.69:1 (green, 150°) to
  // 6.91:1 (magenta, 330°), i.e. AA with room and mostly AAA. A spread bound would have been an
  // arbitrary number tightened until it passed; this fails only if a hue would actually be illegible.
  it('keeps white legible on the CTA stop at every hue', () => {
    const {l, c} = oklchFromHex(CTA_600)
    for (let h = 0; h < 360; h += 30) {
      const fill = hexFromOklch({l, c, h})
      expect(contrastRatio(fill, '#FFFFFF'), `white on ${fill} at ${h}°`).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  // ⚠️ And the honest limit of that: one stop lighter, white is *not* universally safe — the mid
  // brand stop drops to 4.20:1 at 150°. Recorded so nobody assumes every stop carries white; it is
  // why the inverse tokens are measured per palette rather than fixed.
  it('does not promise white on the lighter mid stop', () => {
    const {l, c} = oklchFromHex(VIOLET_500)
    const ratios = Array.from({length: 12}, (_, i) => contrastRatio(hexFromOklch({l, c, h: i * 30}), '#FFFFFF'))
    expect(Math.min(...ratios)).toBeLessThan(AA_NORMAL)
  })

  it('stays inside sRGB for every hue, desaturating where it must', () => {
    const {l, c} = oklchFromHex(VIOLET_500)
    for (let h = 0; h < 360; h += 15) {
      const hex = hexFromOklch({l, c, h})
      expect(hex).toMatch(/^#[0-9A-F]{6}$/)
      // A clipped conversion would land on a channel rail; the bisection should avoid that.
      expect(hex).not.toBe('#FFFFFF')
      expect(hex).not.toBe('#000000')
    }
  })
})
