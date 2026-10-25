import {describe, expect, it} from 'vitest'

import {shouldEvictOnAppStateChange, shouldEvictOnAuthChange} from './ceremony-cache-lifecycle-rules'

describe('shouldEvictOnAppStateChange', () => {
  it('returns true on background — the only state that genuinely backgrounds the app', () => {
    expect(shouldEvictOnAppStateChange('background')).toBe(true)
  })

  it('returns false on inactive — iOS fires this for Face ID / system modals, must NOT wipe the cache', () => {
    expect(shouldEvictOnAppStateChange('inactive')).toBe(false)
  })

  it('returns false on active — the foreground state, never an eviction trigger', () => {
    expect(shouldEvictOnAppStateChange('active')).toBe(false)
  })

  it('returns false on unknown / extension app states', () => {
    expect(shouldEvictOnAppStateChange('unknown')).toBe(false)
    expect(shouldEvictOnAppStateChange('extension')).toBe(false)
  })
})

describe('shouldEvictOnAuthChange', () => {
  it('returns true on a real true → false transition (logout)', () => {
    expect(shouldEvictOnAuthChange(true, false)).toBe(true)
  })

  it('returns false when the user has never logged in (initial render with isUnlocked=false)', () => {
    expect(shouldEvictOnAuthChange(false, false)).toBe(false)
  })

  it('returns false while the user is logged in', () => {
    expect(shouldEvictOnAuthChange(true, true)).toBe(false)
    expect(shouldEvictOnAuthChange(false, true)).toBe(false)
  })
})
