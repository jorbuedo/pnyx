/**
 * The process-wide lock mirror, and the rule a remounted `AuthProvider` starts from.
 *
 * @module
 */

import {beforeEach, describe, expect, it} from 'vitest'
import {
  __resetAuthSessionSnapshotForTests,
  authSessionSnapshot,
  initialSessionUnlocked,
  lockSessionMirrors,
  markSessionLockedSync,
} from './auth-session'

beforeEach(() => {
  __resetAuthSessionSnapshotForTests()
})

describe('initialSessionUnlocked', () => {
  it('starts a cold process locked', () => {
    expect(initialSessionUnlocked()).toBe(false)
  })

  it('starts a remount unlocked once this process has authenticated', () => {
    // The funds-network key remounts AuthProvider. Nothing about the identity or its enclave gate
    // changed, so re-challenging the user would be a prompt for a fact already established.
    authSessionSnapshot.markUnlocked()
    expect(initialSessionUnlocked()).toBe(true)
  })

  it('starts locked again after a lock, which is what keeps the seed honest', () => {
    authSessionSnapshot.markUnlocked()
    lockSessionMirrors()
    expect(initialSessionUnlocked()).toBe(false)
  })

  it('starts locked again after an auto-lock relock', () => {
    // `relockToLogin` does not flip the provider's own state — it clears the mirror and navigates, so
    // this is the only thing standing between an auto-lock and a remount that ignores it.
    authSessionSnapshot.markUnlocked()
    markSessionLockedSync()
    expect(initialSessionUnlocked()).toBe(false)
  })
})
