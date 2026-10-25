import {base64, utf8} from '@pnyx/crypto'
import {describe, expect, it} from 'vitest'
import {readTokenLifetime, refreshDelayMs} from './session-token'

/** A token shaped like the service's: three segments, only the middle one read. */
const tokenWith = (claims: Record<string, unknown>): string => {
  const payload = base64.encode(utf8.encode(JSON.stringify(claims))).replaceAll('=', '')
  return `header.${payload}.signature`
}

const HOUR = 3600

describe('readTokenLifetime', () => {
  it('reads iat and exp from a real-shaped token', () => {
    expect(readTokenLifetime(tokenWith({sub: 'pnyx_id1x', iat: 1_700_000_000, exp: 1_700_003_600}))).toEqual({
      issuedAtSecs: 1_700_000_000,
      expiresAtSecs: 1_700_003_600,
    })
  })

  // The service emits unpadded base64url; a decoder that only took padded standard base64 would read
  // every real token as lifetime-less and silently disable the proactive refresh.
  it('accepts the url-safe unpadded payload the service actually emits', () => {
    const claims = {sub: 'pnyx_id1??>>', iat: 1, exp: 2}
    const payload = base64
      .encode(utf8.encode(JSON.stringify(claims)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
    expect(readTokenLifetime(`h.${payload}.s`)).toEqual({issuedAtSecs: 1, expiresAtSecs: 2})
  })

  // Every one of these is "refresh reactively instead", never a guessed lifetime.
  it.each([
    ['not a jwt', 'nonsense'],
    ['too few segments', 'header.payload'],
    ['payload that is not base64', 'header.!!!!.signature'],
    ['payload that is not json', `header.${base64.encode(utf8.encode('nope')).replaceAll('=', '')}.signature`],
    ['claims that are not an object', tokenWith([] as unknown as Record<string, unknown>)],
  ])('returns undefined for %s', (_label, token) => {
    expect(readTokenLifetime(token)).toBeUndefined()
  })

  it('returns undefined when either claim is missing or not a number', () => {
    expect(readTokenLifetime(tokenWith({iat: 1}))).toBeUndefined()
    expect(readTokenLifetime(tokenWith({exp: 2}))).toBeUndefined()
    expect(readTokenLifetime(tokenWith({iat: '1', exp: 2}))).toBeUndefined()
    expect(readTokenLifetime(tokenWith({iat: 1, exp: Number.POSITIVE_INFINITY}))).toBeUndefined()
  })
})

describe('refreshDelayMs', () => {
  // The hour the service issues today: replaced ten minutes early.
  it('leaves a ten-minute margin on an hour-long token', () => {
    expect(refreshDelayMs({issuedAtSecs: 0, expiresAtSecs: HOUR})).toBe(3000 * 1000)
  })

  // The fixed margin must not outrun a shorter token and schedule the refresh in the past.
  it('caps the margin at half the life of a short token', () => {
    expect(refreshDelayMs({issuedAtSecs: 0, expiresAtSecs: 300})).toBe(150 * 1000)
  })

  it('never schedules sooner than the floor', () => {
    expect(refreshDelayMs({issuedAtSecs: 0, expiresAtSecs: 10})).toBe(30_000)
  })

  // Claims that disagree about the direction of time are the one input that could spin.
  it.each([
    ['an expiry before its issue', {issuedAtSecs: 100, expiresAtSecs: 50}],
    ['a zero-length life', {issuedAtSecs: 100, expiresAtSecs: 100}],
  ])('waits rather than spinning on %s', (_label, lifetime) => {
    expect(refreshDelayMs(lifetime)).toBe(30_000)
  })

  // A device clock hours out of step must not change the schedule: the delay is a duration measured
  // from receipt, and reads only the token's own two server-clock stamps.
  it('is independent of the device clock', () => {
    const early = refreshDelayMs({issuedAtSecs: 0, expiresAtSecs: HOUR})
    const late = refreshDelayMs({issuedAtSecs: 2_000_000_000, expiresAtSecs: 2_000_000_000 + HOUR})
    expect(late).toBe(early)
  })
})
