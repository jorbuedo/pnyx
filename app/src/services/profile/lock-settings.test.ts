import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('../../platform/storage', () => ({
  storage: {getSync: () => null, get: vi.fn(), set: vi.fn(), remove: vi.fn()},
  deviceStorage: {getSync: () => null, get: vi.fn(), set: vi.fn(), remove: vi.fn()},
}))

const {__resetActiveProfileForTests, setActiveProfile} = await import('./active-profile')
const {DECOY_PROFILE_ID, DEFAULT_PROFILE_ID} = await import('./profile-id')
const {visibleLockSettings} = await import('./lock-settings')
const {makeVerifier} = await import('./pin-config')

const SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

const config = (kinds: readonly ('real' | 'decoy' | 'wipe')[]) => ({
  version: 2 as const,
  mode: 'coldStart' as const,
  salt: SALT,
  verifiers: kinds.map((k, i) => makeVerifier(k, `codeInSlot${i}`, SALT)),
})

beforeEach(__resetActiveProfileForTests)

describe('visibleLockSettings', () => {
  it('gives the real profile full administration', () => {
    setActiveProfile(DEFAULT_PROFILE_ID)
    const v = visibleLockSettings(config(['real', 'decoy', 'wipe']))

    expect(v.canDisable).toBe(true)
    expect(v.canManageDecoy).toBe(true)
    expect(v.decoyConfigured).toBe(true)
    expect(v.wipeCodeConfigured).toBe(true)
  })

  it('hides the decoy and the disable switch from inside the decoy', () => {
    // Rendering these would tell whoever holds the phone that a second profile
    // exists, and offering "turn off PIN" would let them strand the real one.
    setActiveProfile(DECOY_PROFILE_ID)
    const v = visibleLockSettings(config(['real', 'decoy', 'wipe']))

    expect(v.canDisable).toBe(false)
    expect(v.canManageDecoy).toBe(false)
    expect(v.decoyConfigured).toBe(false)
    expect(v.wipeCodeConfigured).toBe(false)
  })

  it('still reports a PIN is configured from inside the decoy', () => {
    setActiveProfile(DECOY_PROFILE_ID)
    expect(visibleLockSettings(config(['real', 'decoy'])).configured).toBe(true)
  })

  it('keeps the decoy locked down after a wipe, because the real PIN survives one', () => {
    // A wipe takes the seeds and data, not the lock configuration — so the real
    // profile is still reachable by its own PIN and the decoy has no claim on
    // administration.
    setActiveProfile(DECOY_PROFILE_ID)
    const v = visibleLockSettings(config(['real', 'decoy']))

    expect(v.canDisable).toBe(false)
    expect(v.canManageDecoy).toBe(false)
  })

  it('reports nothing configured when there is no config at all', () => {
    setActiveProfile(DEFAULT_PROFILE_ID)
    const v = visibleLockSettings(undefined)

    expect(v.configured).toBe(false)
    expect(v.mode).toBeUndefined()
    expect(v.decoyConfigured).toBe(false)
  })
})
