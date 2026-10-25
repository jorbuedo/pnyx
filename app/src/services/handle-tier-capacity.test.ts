import {describe, expect, it} from 'vitest'
import {capacitiesFor, capacityFor, SCRIPT_CLASSES} from './handle-tier-capacity'
import {tierRanges} from './handle-tier-ranges'

const tier = (n: number) => {
  const range = tierRanges().find((r) => r.tier === n)
  if (range === undefined) throw new Error(`no tier ${n}`)
  return range
}

describe('capacityFor', () => {
  // Latin is one byte per character, so the byte range *is* the character range.
  it('reads the byte range straight through for Latin', () => {
    expect(capacityFor(tier(6), 'latin')).toEqual({script: 'latin', from: 23, to: 31})
    expect(capacityFor(tier(2), 'latin')).toEqual({script: 'latin', from: 4, to: 4})
  })

  // 23..31 bytes holds 12..15 two-byte characters: 12×2=24 fits, 11×2=22 does not; 15×2=30 fits,
  // 16×2=32 does not.
  it('rounds the minimum up and the maximum down', () => {
    expect(capacityFor(tier(6), 'cyrillic')).toEqual({script: 'cyrillic', from: 12, to: 15})
    expect(capacityFor(tier(6), 'cjk')).toEqual({script: 'cjk', from: 8, to: 10})
  })

  // ⚠️ Tier 1 is exactly three bytes, which no whole number of two-byte characters hits — one is two
  // bytes and two is four. Printing `2–1` is the bug this guards.
  it('reports a tier no whole character count can hit', () => {
    expect(capacityFor(tier(1), 'cyrillic')).toEqual({script: 'cyrillic', from: null, to: null})
    expect(capacityFor(tier(1), 'cjk')).toEqual({script: 'cjk', from: 1, to: 1})
  })

  it('never reports a range below one character', () => {
    expect(capacityFor(tier(0), 'cjk')).toEqual({script: 'cjk', from: null, to: null})
  })

  // The classes exist to be exhaustive over what a name can contain, so every tier must describe
  // itself in at least one of them — a tier reachable by nothing would be unclaimable.
  it('leaves no tier unreachable in every script', () => {
    for (const range of tierRanges()) {
      expect(capacitiesFor(range).some((c) => c.from !== null)).toBe(true)
    }
  })

  it('covers every class, in ascending cost', () => {
    expect(capacitiesFor(tier(6)).map((c) => c.script)).toEqual(SCRIPT_CLASSES)
  })
})
