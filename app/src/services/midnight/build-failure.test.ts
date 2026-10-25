import {describe, expect, it} from 'vitest'

import {buildFailureApiCode, describeBuildFailure, MidnightBuildError, requireCaughtUp} from './build-failure'

describe('requireCaughtUp', () => {
  it('passes a caught-up rail through', () => {
    expect(() => requireCaughtUp(true, 'a transfer', 'unshielded')).not.toThrow()
  })

  it('refuses a rail that is still replaying, as not-ready rather than insufficient-funds', () => {
    // ⚠️ The distinction is the whole point. From a partial history the selection finds too little, and
    // reporting that as `insufficient-funds` tells a user they have too little money when it has simply
    // not been counted yet.
    try {
      requireCaughtUp(false, 'a transfer', 'unshielded')
      expect.unreachable('should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(MidnightBuildError)
      expect((error as MidnightBuildError).cause).toBe('not-ready')
      expect((error as MidnightBuildError).reason).toContain('a transfer')
    }
  })

  it('names the shielded rail differently, because the two are behind for different reasons', () => {
    // A user fixes them differently: one waits for a subscription replay, the other runs a scan. One
    // sentence for both would send half of them looking in the wrong place.
    try {
      requireCaughtUp(false, 'a shielded transfer', 'shielded')
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as MidnightBuildError).cause).toBe('not-ready')
      expect((error as MidnightBuildError).reason).toContain('scanning for its shielded coins')
    }
  })

  it('does not map to the code a malformed request gets', () => {
    // `not-ready` is deliberately not `InvalidRequest`: the page's request was fine.
    expect(buildFailureApiCode('not-ready')).not.toBe(buildFailureApiCode('invalid-recipient'))
  })
})

describe('MidnightBuildError carries its text in `reason`, not `message`', () => {
  it('is an Error whose `message` is empty', () => {
    // ⚠️ Load-bearing, and why `register-dust` throws a plain `Error` instead of this one:
    // `DustRegistrationScreen` renders `error.message` verbatim, so a `Data.TaggedError` there shows a
    // blank note. Pinned so the next person does not "tidy" that call site into this error type.
    const error = new MidnightBuildError({cause: 'not-ready', reason: 'the rail is replaying'})
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('')
    expect(error.reason).toBe('the rail is replaying')
  })
})

describe('describeBuildFailure', () => {
  it('names the cause and the reason, where both ordinary fallbacks render nothing', () => {
    // ⚠️ Measured: `.message` is `''` and `String(error)` is the bare word `MidnightBuildError`. This is
    // the line a send's sponsor fallback logged as `{"error":""}`, leaving the reason it could not pay
    // its own fee unknowable.
    const error = new MidnightBuildError({cause: 'not-ready', reason: 'no DUST block time'})
    expect(error.message).toBe('')
    expect(String(error)).toBe('MidnightBuildError')
    expect(describeBuildFailure(error)).toBe('not-ready: no DUST block time')
  })

  it('keeps an ordinary error’s message', () => {
    expect(describeBuildFailure(new Error('the socket went away'))).toBe('the socket went away')
  })

  it('falls back to stringifying anything else', () => {
    expect(describeBuildFailure('a bare string')).toBe('a bare string')
    // An `Error` with no message must not render as empty either.
    expect(describeBuildFailure(new Error(''))).toBe('Error')
  })
})
