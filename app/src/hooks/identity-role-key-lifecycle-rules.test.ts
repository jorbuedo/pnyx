import {describe, expect, it} from 'vitest'
import {shouldEvictOnAppStateChange} from './ceremony-cache-lifecycle-rules'
import {shouldEvictRoleKeysOnAppStateChange, shouldEvictRoleKeysOnAuthChange} from './identity-role-key-lifecycle-rules'

describe('shouldEvictRoleKeysOnAppStateChange', () => {
  // Backgrounding is continuous on mobile and is not a security event; evicting
  // there would re-prompt biometrics for signatures the user never asked for.
  it.each(['active', 'background', 'inactive', 'unknown', 'extension'])('never evicts on %s', (state) => {
    expect(shouldEvictRoleKeysOnAppStateChange(state)).toBe(false)
  })

  // The asymmetry with the ceremony cache is deliberate and load-bearing: if
  // someone "unifies" the two policies, this fails.
  it('diverges from the ceremony cache on background, by decision', () => {
    expect(shouldEvictOnAppStateChange('background')).toBe(true)
    expect(shouldEvictRoleKeysOnAppStateChange('background')).toBe(false)
  })
})

describe('shouldEvictRoleKeysOnAuthChange', () => {
  it('evicts on a real unlock → lock transition', () => {
    expect(shouldEvictRoleKeysOnAuthChange(true, false)).toBe(true)
  })

  it('does not evict on the initial pre-unlock render', () => {
    expect(shouldEvictRoleKeysOnAuthChange(false, false)).toBe(false)
  })

  it('does not evict while unlocked', () => {
    expect(shouldEvictRoleKeysOnAuthChange(true, true)).toBe(false)
    expect(shouldEvictRoleKeysOnAuthChange(false, true)).toBe(false)
  })
})
