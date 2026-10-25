import {afterEach, describe, expect, it} from 'vitest'
import {MissingEnvError} from '../config/env'
import {declaredIdentityNetwork, identityNetworkDisagreement} from './identity-network'

describe('declaredIdentityNetwork', () => {
  const original = process.env.EXPO_PUBLIC_PNYX_NETWORK

  afterEach(() => {
    if (original === undefined) delete process.env.EXPO_PUBLIC_PNYX_NETWORK
    else process.env.EXPO_PUBLIC_PNYX_NETWORK = original
  })

  it('returns the declared network, tolerating env-file whitespace', () => {
    process.env.EXPO_PUBLIC_PNYX_NETWORK = ' preprod\t'
    expect(declaredIdentityNetwork()).toBe('preprod')
  })

  it.each([[undefined], [''], ['   ']])('throws rather than inventing a network for %s', (value) => {
    if (value === undefined) delete process.env.EXPO_PUBLIC_PNYX_NETWORK
    else process.env.EXPO_PUBLIC_PNYX_NETWORK = value

    // It used to return null, and null meant "ask the content service" — which is how a
    // misconfigured service URL became an onboarding screen hanging on a TCP timeout while doing
    // work that is purely local. A blank value must not derive identities under an empty domain
    // separator either, so `''` is as fatal as unset.
    expect(() => declaredIdentityNetwork()).toThrow(MissingEnvError)
  })
})

describe('identityNetworkDisagreement', () => {
  it('is silent when both agree', () => {
    expect(identityNetworkDisagreement('preprod', 'preprod')).toBeUndefined()
  })

  it('names both sides when they disagree', () => {
    const reason = identityNetworkDisagreement('preprod', 'undeployed')
    expect(reason).toContain("'preprod'")
    expect(reason).toContain("'undeployed'")
  })

  it('rejects a mismatch that would silently hand over a different identity', () => {
    // The defect this guards: the picker derived on one network while sign-in derived on another,
    // so the avatar the user chose was not the identity they got.
    expect(identityNetworkDisagreement('undeployed', 'preprod')).toBeDefined()
  })
})
