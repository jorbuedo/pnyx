import {describe, expect, it} from 'vitest'

import {type AccentName, accentNames, accentRamps, schemes} from './accent-ramps'
import {AA_LARGE, AA_NORMAL, contrastRatio, flatten} from './contrast'
import {oklchFromHex} from './oklch'
import {darkColors, lightColors} from './presets/pnyx-colors'

const HEX = /^#[0-9A-Fa-f]{6}$/

describe('the default scheme', () => {
  // ⚠️ Violet is the shipped look. It is kept verbatim rather than regenerated precisely so that
  // adding schemes cannot restyle the app — round-tripping it through OkLCh lands on *almost* the
  // same hexes, and "almost" is a silent redesign. This test is what makes that guarantee real.
  it('is byte-for-byte the palette that shipped', () => {
    expect(accentRamps.violet).toEqual({
      primary50: '#F3F1FE',
      primary200: '#CAC4F8',
      primary300: '#A69CF2',
      primary400: '#8779EC',
      primary500: '#6C5CE7',
      primary600: '#5443D6',
      primary700: '#4131B9',
      primary800: '#372B91',
      lavender500: '#A29BFE',
      lilac: '#A29BFE',
      gradientAccentStart: '#6C5CE7',
    })
  })
})

describe('every scheme', () => {
  it('provides all eleven accent values as opaque hex', () => {
    for (const name of accentNames) {
      for (const [key, value] of Object.entries(accentRamps[name])) {
        expect(value, `${name}.${key}`).toMatch(HEX)
      }
    }
  })

  it('keeps the ramp ordered light to dark, as the stop numbers claim', () => {
    for (const name of accentNames) {
      const ramp = accentRamps[name]
      const stops = [
        ramp.primary50,
        ramp.primary200,
        ramp.primary300,
        ramp.primary400,
        ramp.primary500,
        ramp.primary600,
        ramp.primary700,
        ramp.primary800,
      ]
      const lightness = stops.map((hex) => oklchFromHex(hex).l)
      for (let i = 1; i < lightness.length; i++) {
        expect(lightness[i], `${name} stop ${i} vs ${i - 1}`).toBeLessThan(lightness[i - 1] as number)
      }
    }
  })

  // The names are read by people in the picker, and OkLCh rotates violet → purple → magenta → red,
  // which is the opposite of a first guess — the first cut of this file had "cyan" on a crimson.
  it('lands in the hue band its name claims', () => {
    const bands: Record<AccentName, [number, number]> = {
      violet: [280, 310],
      purple: [310, 340],
      magenta: [340, 360],
      crimson: [0, 40],
      orange: [40, 70],
      amber: [70, 95],
      olive: [95, 120],
      green: [120, 150],
      emerald: [150, 175],
      teal: [175, 205],
      cyan: [205, 235],
      azure: [235, 280],
    }
    for (const name of accentNames) {
      const hue = oklchFromHex(accentRamps[name].primary500).h
      const [low, high] = bands[name]
      expect(hue, `${name} primary500 hue`).toBeGreaterThanOrEqual(low)
      expect(hue, `${name} primary500 hue`).toBeLessThan(high)
    }
  })
})

describe('the tinted neutrals', () => {
  // ⚠️ The property the whole tint rests on. Every text-on-surface pair in the app is a contrast
  // between two neutrals; rotating hue while holding lightness leaves every one of those ratios
  // exactly as violet had it, so no scheme can make the app harder to read. If a rotation ever
  // clipped a channel — the gamut case `hexFromOklch` bisects to avoid — lightness would move and
  // this is what would catch it.
  it('keeps every neutral at violet’s lightness, so contrast cannot drift', () => {
    const reference = schemes.violet.neutral
    for (const name of accentNames) {
      const neutral = schemes[name].neutral
      for (const key of Object.keys(reference) as (keyof typeof reference)[]) {
        expect(oklchFromHex(neutral[key]).l, `${name}.${key}`).toBeCloseTo(oklchFromHex(reference[key]).l, 2)
      }
    }
  })

  it('leaves violet’s own surfaces untouched', () => {
    expect(schemes.violet.neutral.darkBg).toBe('#08081A')
    expect(schemes.violet.neutral.darkSurface).toBe('#161533')
    expect(schemes.violet.neutral.neutral900).toBe('#0C0B23')
  })

  // The point of the change: a scheme's surfaces sit near its own hue, not violet's.
  it('points each scheme’s surfaces at its own hue', () => {
    for (const name of accentNames) {
      const surfaceHue = oklchFromHex(schemes[name].neutral.darkSurface).h
      const accentHue = oklchFromHex(schemes[name].accent.primary500).h
      const apart = Math.abs(((surfaceHue - accentHue + 540) % 360) - 180)
      expect(apart, `${name}: surface ${surfaceHue.toFixed(0)}° vs accent ${accentHue.toFixed(0)}°`).toBeLessThan(40)
    }
  })

  // ⚠️ The tint is hue-dependent, and this is the observation it encodes: a navy reads as ordinary
  // dark-UI shadow while a dark olive at the same chroma reads as a decision. Damped uniformly, the
  // warm and green schemes were still too strong at *less* chroma than violet — so hues far from
  // blue-violet are pulled harder toward grey.
  it('keeps more tint near blue than opposite it', () => {
    const chroma = (name: AccentName) => oklchFromHex(schemes[name].neutral.darkSurface).c
    // Azure and purple flank violet; olive and green sit across the wheel from it.
    for (const cool of ['azure', 'purple'] as const) {
      for (const warm of ['olive', 'green', 'amber'] as const) {
        expect(chroma(cool), `${cool} vs ${warm}`).toBeGreaterThan(chroma(warm) * 2)
      }
    }
  })

  // ⚠️ A cast, not a colour scheme of its own — and violet is the ceiling, not the average. Its
  // neutrals were designed by hand at chroma 0.057; the derived ones are damped to ~0.034, because
  // equal chroma is not equal presence across the wheel and green at violet's level stopped reading
  // as a tint. Measured against the accent instead would be wrong: a gamut-limited accent like teal
  // reaches only 0.097, so "a third of the accent" moves with the hue rather than with the design.
  it('keeps every scheme’s surfaces no more tinted than violet’s', () => {
    const ceiling = oklchFromHex(schemes.violet.neutral.darkSurface).c
    for (const name of accentNames) {
      expect(oklchFromHex(schemes[name].neutral.darkSurface).c, name).toBeLessThanOrEqual(ceiling + 1e-6)
    }
  })
})

/**
 * The contrast harness.
 *
 * ⚠️ **This is what makes a dozen schemes safe.** Each pair below is a place a colour sits directly
 * on another and has to stay legible; the inverse tokens are chosen by measurement, so a failure
 * here means no polarity works and the *ramp* has to move, not the token.
 */
describe('the contrast harness', () => {
  const modes = [
    {label: 'light', build: lightColors},
    {label: 'dark', build: darkColors},
  ] as const

  for (const {label, build} of modes) {
    describe(label, () => {
      it('keeps the primary label legible on the primary fill', () => {
        for (const name of accentNames) {
          const colors = build(schemes[name])
          const ratio = contrastRatio(colors.primaryDefault, colors.primaryInverse)
          expect(
            ratio,
            `${name}/${label}: ${colors.primaryInverse} on ${colors.primaryDefault}`,
          ).toBeGreaterThanOrEqual(AA_NORMAL)
        }
      })

      it('keeps the secondary label legible on the secondary fill', () => {
        for (const name of accentNames) {
          const colors = build(schemes[name])
          const ratio = contrastRatio(colors.secondaryDefault, colors.secondaryInverse)
          expect(
            ratio,
            `${name}/${label}: ${colors.secondaryInverse} on ${colors.secondaryDefault}`,
          ).toBeGreaterThanOrEqual(AA_NORMAL)
        }
      })

      // The accent carries links, selected borders and active glyphs on the app canvas. AA_LARGE is
      // the right bar for those — they are not body text — but below it the accent stops reading as
      // a distinct thing at all.
      it('keeps the accent distinguishable against the canvas', () => {
        for (const name of accentNames) {
          const colors = build(schemes[name])
          const ratio = contrastRatio(colors.primaryDefault, colors.backgroundDefault)
          expect(
            ratio,
            `${name}/${label}: ${colors.primaryDefault} on ${colors.backgroundDefault}`,
          ).toBeGreaterThanOrEqual(AA_LARGE)
        }
      })

      // ⚠️ Flattened first: these accent surfaces are translucent in dark mode, and an unflattened
      // ratio is `NaN` — which passes nothing and fails nothing, so the check would have been
      // decorative. They matter precisely because they are the accent-tinted backgrounds.
      it('keeps body text legible on the muted accent surfaces', () => {
        for (const name of accentNames) {
          const colors = build(schemes[name])
          for (const surface of [colors.primaryMuted, colors.accentMuted] as const) {
            const opaque = flatten(surface, colors.backgroundDefault)
            const ratio = contrastRatio(opaque, colors.textDefault)
            expect(ratio, `${name}/${label}: text on ${surface} over canvas`).toBeGreaterThanOrEqual(AA_NORMAL)
          }
        }
      })
    })
  }
})
