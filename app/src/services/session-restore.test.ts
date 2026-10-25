import {describe, expect, it} from 'vitest'
import {MAX_RESTORE_AGE_MS, restoreDecision} from './session-restore'

/** An hour, which is what the service issues. */
const HOUR = {issuedAtSecs: 1_000_000, expiresAtSecs: 1_000_000 + 3600}
const MINUTE = 60_000

describe('restoreDecision', () => {
  it('uses a token minted moments ago', () => {
    expect(restoreDecision({ageMs: 0, lifetime: HOUR})).toBe('use')
    expect(restoreDecision({ageMs: 5 * MINUTE, lifetime: HOUR})).toBe('use')
  })

  it('uses one just inside the bound and discards one just outside it', () => {
    expect(restoreDecision({ageMs: MAX_RESTORE_AGE_MS - 1, lifetime: HOUR})).toBe('use')
    expect(restoreDecision({ageMs: MAX_RESTORE_AGE_MS, lifetime: HOUR})).toBe('discard')
  })

  it('discards a token past half its hour even though the service would still accept it', () => {
    // The point of the bound: nothing can refresh a restored token, so riding it to 59 minutes
    // means handing the next request a 401 nobody can recover from without a prompt.
    expect(restoreDecision({ageMs: 45 * MINUTE, lifetime: HOUR})).toBe('discard')
  })

  it('discards one older than its own stated life', () => {
    const short = {issuedAtSecs: 1_000_000, expiresAtSecs: 1_000_000 + 60}
    expect(restoreDecision({ageMs: 61_000, lifetime: short})).toBe('discard')
    expect(restoreDecision({ageMs: 30_000, lifetime: short})).toBe('use')
  })

  it('still bounds a token that stated no lifetime', () => {
    // `readTokenLifetime` answers undefined for a token whose claims it cannot read. That is a
    // reason to be more careful, not less.
    expect(restoreDecision({ageMs: 5 * MINUTE, lifetime: undefined})).toBe('use')
    expect(restoreDecision({ageMs: 31 * MINUTE, lifetime: undefined})).toBe('discard')
  })

  it('discards when the clock has moved backwards, rather than trusting a negative age', () => {
    expect(restoreDecision({ageMs: -1, lifetime: HOUR})).toBe('discard')
    expect(restoreDecision({ageMs: Number.NaN, lifetime: HOUR})).toBe('discard')
  })

  it('falls back to the age bound when the claims disagree about the direction of time', () => {
    const backwards = {issuedAtSecs: 1_000_000, expiresAtSecs: 999_000}
    expect(restoreDecision({ageMs: MINUTE, lifetime: backwards})).toBe('use')
    expect(restoreDecision({ageMs: 31 * MINUTE, lifetime: backwards})).toBe('discard')
  })
})
