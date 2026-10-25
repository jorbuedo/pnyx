import {describe, expect, it} from 'vitest'
import {permitIssuer} from './dm-permit-issuer'

const segment = (value: unknown): string =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const token = (payload: unknown): string => `${segment({alg: 'ES256'})}.${segment(payload)}.signature`

describe('permitIssuer', () => {
  it('reads the issuer a permit names', () => {
    expect(permitIssuer(token({sub: 'mn_addr1alice', aud: 'pnyx-dm-permit'}))).toBe('mn_addr1alice')
  })

  // The audience is what separates a permit from a session token signed by the same key. Filing a
  // session token as a permit would leave the user unable to message anyone, with nothing to see.
  it('refuses a token of the wrong kind, however well formed', () => {
    expect(permitIssuer(token({sub: 'mn_addr1alice', aud: 'pnyx'}))).toBeUndefined()
    expect(permitIssuer(token({sub: 'mn_addr1alice'}))).toBeUndefined()
  })

  it('refuses anything that is not a readable three-part token', () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', 'a.!!!.c']) expect(permitIssuer(bad)).toBeUndefined()
  })

  it('refuses a payload with no usable subject', () => {
    expect(permitIssuer(token({aud: 'pnyx-dm-permit'}))).toBeUndefined()
    expect(permitIssuer(token({sub: '', aud: 'pnyx-dm-permit'}))).toBeUndefined()
    expect(permitIssuer(token({sub: 42, aud: 'pnyx-dm-permit'}))).toBeUndefined()
  })
})
