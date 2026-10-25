import {describe, expect, it} from 'vitest'
import {oklchFromHex} from '../theme/oklch'
import {isSecretTier, TIER_ACCENT, TIER_COIN, TIER_NAME_KEY, visibleTiers} from './handle-tier-display'
import {tierRanges} from './handle-tier-ranges'

const RANGES = tierRanges()

describe('tier presentation', () => {
  it('names and colours every tier the contract defines', () => {
    for (const range of RANGES) {
      expect(TIER_NAME_KEY[range.tier]).toBeDefined()
      expect(TIER_ACCENT[range.tier]).toMatch(/^#[0-9A-F]{6}$/i)
    }
  })

  it('gives each tier its own name and accent', () => {
    expect(new Set(Object.values(TIER_NAME_KEY)).size).toBe(RANGES.length)
    expect(new Set(Object.values(TIER_ACCENT)).size).toBe(RANGES.length)
  })
})

describe('TIER_COIN', () => {
  const lightness = (hex: string) => oklchFromHex(hex).l

  it('strikes a face for every tier the contract defines', () => {
    for (const range of RANGES) {
      const coin = TIER_COIN[range.tier]
      expect(coin).toBeDefined()
      expect(coin?.fill[0]).toMatch(/^#[0-9A-F]{6}$/)
      expect(coin?.fill[1]).toMatch(/^#[0-9A-F]{6}$/)
      expect(coin?.stamp).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  // The rim catches the light, the field lies under it, and the mark is struck into the field. Get
  // that order wrong and the coin reads as a flat swatch with a bright smudge on it.
  it('runs rim brighter than field, and the mark darker than both', () => {
    for (const range of RANGES) {
      const coin = TIER_COIN[range.tier]
      if (coin === undefined) throw new Error(`no coin for tier ${range.tier}`)
      expect(lightness(coin.fill[0])).toBeGreaterThan(lightness(coin.fill[1]))
      expect(lightness(coin.stamp)).toBeLessThan(lightness(coin.fill[1]))
    }
  })

  it('keeps each face in its accent hue, so the ladder reads as one metal', () => {
    for (const range of RANGES) {
      const coin = TIER_COIN[range.tier]
      const accent = TIER_ACCENT[range.tier]
      if (coin === undefined || accent === undefined) throw new Error(`no coin for tier ${range.tier}`)
      const hue = oklchFromHex(accent).h
      for (const shade of [coin.fill[0], coin.fill[1], coin.stamp]) {
        // Widest drift is the near-neutral silver, whose hue is barely defined at all.
        expect(Math.abs(oklchFromHex(shade).h - hue)).toBeLessThan(12)
      }
    }
  })

  // `ChamferPaint` is memoised on its props, so a rebuilt tuple repaints every coin on every render.
  it('hands out the same gradient tuple every time', () => {
    expect(TIER_COIN[3]?.fill).toBe(TIER_COIN[3]?.fill)
  })
})

describe('visibleTiers', () => {
  const shown = (held?: ReadonlyMap<number, bigint>) => visibleTiers(RANGES, held).map((r) => r.tier)

  it('hides the two shortest lengths from someone holding nothing', () => {
    expect(shown(new Map())).toEqual([2, 3, 4, 5, 6])
    expect(isSecretTier(0)).toBe(true)
    expect(isSecretTier(1)).toBe(true)
    expect(isSecretTier(2)).toBe(false)
  })

  it('reveals a secret length to whoever holds a ticket for it', () => {
    expect(shown(new Map([[1, 1n]]))).toEqual([1, 2, 3, 4, 5, 6])
    expect(shown(new Map([[0, 2n]]))).toEqual([0, 2, 3, 4, 5, 6])
  })

  // ⚠️ Not knowing is not a reason to reveal. A wallet still syncing would otherwise advertise the
  // lengths that are deliberately unadvertised.
  it('keeps them hidden while holdings are unknown', () => {
    expect(shown(undefined)).toEqual([2, 3, 4, 5, 6])
  })

  it('does not let one secret tier reveal the other', () => {
    expect(shown(new Map([[0, 1n]]))).not.toContain(1)
  })

  it('never hides an ordinary length', () => {
    expect(shown(new Map())).toEqual(RANGES.filter((r) => !isSecretTier(r.tier)).map((r) => r.tier))
  })
})
