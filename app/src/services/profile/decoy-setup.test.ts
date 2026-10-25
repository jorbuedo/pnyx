import {describe, expect, it, vi} from 'vitest'

vi.mock('../../platform/storage', () => ({
  storage: {getSync: () => null, get: vi.fn(), set: vi.fn(), remove: vi.fn()},
  deviceStorage: {getSync: () => null, get: vi.fn(), set: vi.fn(), remove: vi.fn()},
}))

const {shouldExplainDecoySetup} = await import('./decoy-setup')
const {DECOY_PROFILE_ID, DEFAULT_PROFILE_ID} = await import('./profile-id')

describe('shouldExplainDecoySetup', () => {
  it('explains only inside the decoy, and only while setup is pending', () => {
    expect(shouldExplainDecoySetup(DECOY_PROFILE_ID, true)).toBe(true)
  })

  it('stays silent in the decoy once setup is no longer pending', () => {
    // This is the whole point. An un-onboarded decoy opened by anyone else must
    // read as an ordinary fresh install — copy that says "set up your second
    // profile" would hand over the one fact the feature exists to hide.
    expect(shouldExplainDecoySetup(DECOY_PROFILE_ID, false)).toBe(false)
  })

  it('never explains in the real profile, pending or not', () => {
    expect(shouldExplainDecoySetup(DEFAULT_PROFILE_ID, true)).toBe(false)
    expect(shouldExplainDecoySetup(DEFAULT_PROFILE_ID, false)).toBe(false)
  })

  it('is false for every combination except decoy-and-pending', () => {
    const combinations = [
      [DEFAULT_PROFILE_ID, false],
      [DEFAULT_PROFILE_ID, true],
      [DECOY_PROFILE_ID, false],
      [DECOY_PROFILE_ID, true],
    ] as const

    const explaining = combinations.filter(([profile, pending]) => shouldExplainDecoySetup(profile, pending))

    expect(explaining).toEqual([[DECOY_PROFILE_ID, true]])
  })
})
