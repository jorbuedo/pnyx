import {describe, expect, it} from 'vitest'

import {valueAppliesToBuildNumber} from './feature-flag-build-number.js'

describe('valueAppliesToBuildNumber', () => {
  it('returns true for plain boolean values regardless of build number', () => {
    expect(valueAppliesToBuildNumber(true, 1)).toBe(true)
    expect(valueAppliesToBuildNumber(false, 999)).toBe(true)
  })

  it('returns true for object values without min/max constraints', () => {
    expect(valueAppliesToBuildNumber({enabled: true}, 1)).toBe(true)
    expect(valueAppliesToBuildNumber({enabled: true, rolloutPercentage: 50}, 1)).toBe(true)
  })

  it('returns true when buildNumber meets minBuildNumber', () => {
    expect(valueAppliesToBuildNumber({enabled: true, minBuildNumber: 42}, 42)).toBe(true)
    expect(valueAppliesToBuildNumber({enabled: true, minBuildNumber: 42}, 43)).toBe(true)
    expect(valueAppliesToBuildNumber({enabled: true, minBuildNumber: 42}, 1000)).toBe(true)
  })

  it('returns false when buildNumber is below minBuildNumber', () => {
    expect(valueAppliesToBuildNumber({enabled: true, minBuildNumber: 42}, 41)).toBe(false)
    expect(valueAppliesToBuildNumber({enabled: true, minBuildNumber: 42}, 1)).toBe(false)
  })

  it('returns true when buildNumber is at or below maxBuildNumber', () => {
    expect(valueAppliesToBuildNumber({enabled: true, maxBuildNumber: 100}, 100)).toBe(true)
    expect(valueAppliesToBuildNumber({enabled: true, maxBuildNumber: 100}, 50)).toBe(true)
  })

  it('returns false when buildNumber is above maxBuildNumber', () => {
    expect(valueAppliesToBuildNumber({enabled: true, maxBuildNumber: 100}, 101)).toBe(false)
    expect(valueAppliesToBuildNumber({enabled: true, maxBuildNumber: 100}, 9999)).toBe(false)
  })

  it('respects combined min + max bounds', () => {
    const value = {enabled: true, minBuildNumber: 42, maxBuildNumber: 99}
    expect(valueAppliesToBuildNumber(value, 60)).toBe(true)
    expect(valueAppliesToBuildNumber(value, 41)).toBe(false)
    expect(valueAppliesToBuildNumber(value, 100)).toBe(false)
  })

  it('fails open when buildNumber is 0 (unknown — dev / Expo Go)', () => {
    expect(valueAppliesToBuildNumber({enabled: true, minBuildNumber: 42}, 0)).toBe(true)
    expect(valueAppliesToBuildNumber({enabled: true, maxBuildNumber: 1}, 0)).toBe(true)
  })

  it('fails open when buildNumber is non-finite', () => {
    expect(valueAppliesToBuildNumber({enabled: true, minBuildNumber: 42}, Number.NaN)).toBe(true)
    expect(valueAppliesToBuildNumber({enabled: true, minBuildNumber: 42}, Number.POSITIVE_INFINITY)).toBe(true)
  })
})
