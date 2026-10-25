import {
  UR_TYPE_QR_HARDWARE_CALL,
  UR_TYPE_SIGN_CIP8_DATA_REQUEST,
  UR_TYPE_SIGN_DATA_REQUEST,
  UR_TYPE_SIGN_REQUEST,
  UR_TYPE_SIGN_TX_HASH_REQUEST,
} from '@pnyx/ur'
import {describe, expect, it} from 'vitest'
import {ACCEPTED_UR_TYPES, isAcceptedUrType, routeForScannedUr} from './scan-routing'

describe('routeForScannedUr', () => {
  it.each([
    [UR_TYPE_SIGN_REQUEST, '/wallet/air-gap-request?scan=s1'],
    [UR_TYPE_SIGN_TX_HASH_REQUEST, '/wallet/air-gap-request?scan=s1'],
    [UR_TYPE_SIGN_DATA_REQUEST, '/wallet/air-gap-message?scan=s1'],
    [UR_TYPE_SIGN_CIP8_DATA_REQUEST, '/wallet/air-gap-message?scan=s1'],
    [UR_TYPE_QR_HARDWARE_CALL, '/wallet/air-gap-export?scan=s1'],
  ])('routes %s', (urType, expected) => {
    expect(routeForScannedUr(urType, 's1')).toBe(expected)
  })

  it('routes every accepted type somewhere', () => {
    // The Record makes this true at compile time; asserting it too catches a destination that
    // typechecks but is empty.
    for (const urType of ACCEPTED_UR_TYPES) {
      expect(routeForScannedUr(urType, 's1')).toMatch(/^\/wallet\/air-gap-[a-z]+\?scan=s1$/)
    }
  })

  it('sends the two refused-by-name types to a screen that can explain them', () => {
    // Not to a generic error: the user is owed the reason their other wallet's request is one
    // Pnyx will never answer.
    expect(routeForScannedUr(UR_TYPE_SIGN_TX_HASH_REQUEST, 's')).toContain('air-gap-request')
    expect(routeForScannedUr(UR_TYPE_SIGN_DATA_REQUEST, 's')).toContain('air-gap-message')
  })

  it('refuses to guess a route for a type the scanner never accepted', () => {
    expect(routeForScannedUr('crypto-psbt', 's1')).toBeNull()
  })

  it('narrows accepted types', () => {
    expect(isAcceptedUrType(UR_TYPE_SIGN_CIP8_DATA_REQUEST)).toBe(true)
    expect(isAcceptedUrType('eth-sign-request')).toBe(false)
  })
})
