import {describe, expect, it} from 'vitest'
import {
  canRetryRegistration,
  canWriteIdentityRow,
  type IdentityRegistrationInputs,
  identityRegistrationState,
} from './identity-registration-state'

const base: IdentityRegistrationInputs = {
  hasIdentity: true,
  hasSession: false,
  cachedRegistered: false,
  lastFailure: undefined,
}

describe('identityRegistrationState', () => {
  it('reports no-identity before onboarding, whatever else is set', () => {
    expect(identityRegistrationState({...base, hasIdentity: false})).toBe('no-identity')
    expect(identityRegistrationState({...base, hasIdentity: false, hasSession: true})).toBe('no-identity')
  })

  it('reports active for a live session', () => {
    expect(identityRegistrationState({...base, hasSession: true})).toBe('active')
  })

  it('prefers a live session over a stale failure', () => {
    // A refusal followed by a successful retry must not leave the screen warning.
    expect(identityRegistrationState({...base, hasSession: true, lastFailure: 'rejected'})).toBe('active')
  })

  it('reports registered when a prior login proved the row but there is no session now', () => {
    // Offline, or the token lapsed. The row exists, so nothing is wrong.
    expect(identityRegistrationState({...base, cachedRegistered: true})).toBe('registered')
    expect(identityRegistrationState({...base, cachedRegistered: true, lastFailure: 'unreachable'})).toBe('registered')
  })

  it('reports unregistered only when the service answered and refused', () => {
    // `401 {"error":"identity has not been registered"}` is exactly this bucket.
    expect(identityRegistrationState({...base, lastFailure: 'rejected'})).toBe('unregistered')
  })

  it.each([
    ['unreachable'],
    ['unknown'],
    ['wallet'],
    ['misconfigured'],
  ] as const)('does not blame the identity for a %s failure', (failure) => {
    // None of these got far enough to learn anything about the chain. `misconfigured` especially:
    // the identity may be fine on its own network and this build is talking to the wrong service,
    // so "re-register" would be advice that cannot work.
    expect(identityRegistrationState({...base, lastFailure: failure})).toBe('unknown')
  })

  it('reports unknown before any attempt — not unregistered', () => {
    // Collapsing "not established" into "no" is the same lie in the other direction: it would warn
    // every user who opened the tab while offline.
    expect(identityRegistrationState(base)).toBe('unknown')
  })
})

describe('canRetryRegistration', () => {
  it('offers a retry exactly where one could help', () => {
    expect(canRetryRegistration('unregistered')).toBe(true)
    expect(canRetryRegistration('unknown')).toBe(true)
  })

  it('does not offer to fix what is not broken', () => {
    // `registered` means the row is on chain; a sign-in button there implies a problem that is not
    // there. `no-identity` belongs to the sign-in card, not a retry.
    expect(canRetryRegistration('active')).toBe(false)
    expect(canRetryRegistration('registered')).toBe(false)
    expect(canRetryRegistration('no-identity')).toBe(false)
  })
})

describe('canWriteIdentityRow', () => {
  // The name claim and the contact card both write `identity(C)`, which does not exist until the row
  // is published. `IdScreen` used to gate them on "an identity exists on this device", so a brand-new
  // identity was offered a claim it could not complete.
  it('offers a row-writing surface only on positive evidence the row exists', () => {
    expect(canWriteIdentityRow('active')).toBe(true)
    expect(canWriteIdentityRow('registered')).toBe(true)
  })

  it('withholds it where there is nothing to write to', () => {
    expect(canWriteIdentityRow('unregistered')).toBe(false)
    expect(canWriteIdentityRow('no-identity')).toBe(false)
    // `unknown` is not "offline with a published row" — that degrades to `registered` via the durable
    // cache. It is a device that has never proved the row exists, so there is nothing to write yet.
    expect(canWriteIdentityRow('unknown')).toBe(false)
  })

  // The two gates are not complements: `unknown` offers a retry *and* withholds the card, which is
  // the whole point of keeping "not established" distinct from "no".
  it('is not the inverse of canRetryRegistration', () => {
    expect(canRetryRegistration('unknown')).toBe(true)
    expect(canWriteIdentityRow('unknown')).toBe(false)
  })
})
