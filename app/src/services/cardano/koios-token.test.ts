import {describe, expect, it} from 'vitest'
import {isKoiosTokenExpired, koiosTokenExp} from './koios-token'

// A JWT is header.payload.signature; only the payload's `exp` matters here.
const jwt = (payload: object): string => {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${b64({alg: 'HS256', typ: 'JWT'})}.${b64(payload)}.sig`
}

const NOW = Date.parse('2026-07-19T00:00:00Z')

describe('koiosTokenExp', () => {
  it('reads exp from the JWT payload; null when unparseable', () => {
    expect(koiosTokenExp(jwt({exp: 1815952634}))).toBe(1815952634)
    expect(koiosTokenExp('not-a-jwt')).toBeNull()
    expect(koiosTokenExp(jwt({tier: 1}))).toBeNull()
  })
})

describe('isKoiosTokenExpired', () => {
  it('undefined token ⇒ expired (must register)', () => {
    expect(isKoiosTokenExpired(undefined, NOW)).toBe(true)
  })

  it('far-future exp is live; within skew of expiry is expired', () => {
    const nowSec = Math.floor(NOW / 1000)
    expect(isKoiosTokenExpired(jwt({exp: nowSec + 400_000}), NOW)).toBe(false)
    // default skew is one day — a token expiring in an hour reads as expired
    expect(isKoiosTokenExpired(jwt({exp: nowSec + 3_600}), NOW)).toBe(true)
  })

  it('a token with no exp is treated as live (do not thrash re-registration)', () => {
    expect(isKoiosTokenExpired(jwt({tier: 1}), NOW)).toBe(false)
  })
})
