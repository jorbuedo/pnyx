import {describe, expect, it} from 'vitest'
import {DEVICE_GLOBAL_KEYS, isDeviceGlobalKey, keyBelongsToProfile, keysToWipe} from './key-ownership'
import {DECOY_PROFILE_ID, DEFAULT_PROFILE_ID, profileKeyPrefix} from './profile-id'

const decoyKey = (key: string): string => `${profileKeyPrefix(DECOY_PROFILE_ID)}${key}`

describe('keyBelongsToProfile', () => {
  it('gives the default profile every unprefixed, non-global key', () => {
    expect(keyBelongsToProfile('@pnyx/wallet/groups', DEFAULT_PROFILE_ID)).toBe(true)
    expect(keyBelongsToProfile('pnyx:identity', DEFAULT_PROFILE_ID)).toBe(true)
  })

  it('never gives a device-global key to any profile', () => {
    for (const key of DEVICE_GLOBAL_KEYS) {
      expect(keyBelongsToProfile(key, DEFAULT_PROFILE_ID)).toBe(false)
      expect(keyBelongsToProfile(key, DECOY_PROFILE_ID)).toBe(false)
    }
  })

  it("never gives the decoy's keys to the default profile", () => {
    // This is the one that matters: the default profile is unprefixed, so a
    // naive "everything unprefixed" rule would sweep the decoy up with it and
    // destroy the decoy while the user is standing in it.
    expect(keyBelongsToProfile(decoyKey('@pnyx/wallet/groups'), DEFAULT_PROFILE_ID)).toBe(false)
  })

  it('gives the decoy only its own prefixed keys', () => {
    expect(keyBelongsToProfile(decoyKey('@pnyx/wallet/groups'), DECOY_PROFILE_ID)).toBe(true)
    expect(keyBelongsToProfile('@pnyx/wallet/groups', DECOY_PROFILE_ID)).toBe(false)
  })
})

describe('keysToWipe', () => {
  const all = [
    '@pnyx/wallet/groups',
    'pnyx:identity',
    '@pnyx/lock-config',
    '@pnyx/lock-armed',
    '@pnyx/pending-wipe',
    '@pnyx/installation-id',
    decoyKey('@pnyx/wallet/groups'),
    decoyKey('pnyx:identity'),
  ]

  it('wiping the real profile spares the lock config, the resume marker and the decoy', () => {
    const doomed = keysToWipe(all, DEFAULT_PROFILE_ID)

    expect(doomed).toContain('@pnyx/wallet/groups')
    expect(doomed).toContain('pnyx:identity')

    // Taking the lock config would leave the decoy unreachable; taking the
    // pending marker mid-wipe would strand an interrupted wipe forever.
    expect(doomed).not.toContain('@pnyx/lock-config')
    expect(doomed).not.toContain('@pnyx/pending-wipe')
    expect(doomed).not.toContain(decoyKey('@pnyx/wallet/groups'))
  })

  it('wiping the decoy touches nothing of the real profile', () => {
    const doomed = keysToWipe(all, DECOY_PROFILE_ID)

    expect(doomed).toEqual([decoyKey('@pnyx/wallet/groups'), decoyKey('pnyx:identity')])
  })

  it('classifies every key as exactly one of global, default, or decoy', () => {
    for (const key of all) {
      const owners = [
        isDeviceGlobalKey(key),
        keyBelongsToProfile(key, DEFAULT_PROFILE_ID),
        keyBelongsToProfile(key, DECOY_PROFILE_ID),
      ].filter(Boolean)
      expect(owners).toHaveLength(1)
    }
  })
})
