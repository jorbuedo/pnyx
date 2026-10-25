import {describe, expect, it} from 'vitest'

import {MidnightBuildError} from './build-failure'
import {buildFailureCopyKey} from './build-failure-copy'

describe('buildFailureCopyKey', () => {
  it.each([
    ['invalid-recipient', 'invalidRecipient'],
    ['malformed-input', 'malformedInput'],
    ['insufficient-funds', 'insufficientFunds'],
    ['too-many-inputs', 'tooManyInputs'],
  ] as const)('maps %s to %s on either rail', (cause, key) => {
    const error = new MidnightBuildError({cause, reason: 'whatever'})
    expect(buildFailureCopyKey(error, 'shielded')).toBe(key)
    expect(buildFailureCopyKey(error, 'unshielded')).toBe(key)
  })

  it('splits not-ready by rail, because the next action differs', () => {
    // ⚠️ An unshielded wallet is mid-replay and finishes on its own. A shielded one is not scanning at
    // all — nothing syncs that rail in the background — so telling its user to wait would be telling
    // them to wait for something that never happens.
    const error = new MidnightBuildError({cause: 'not-ready', reason: 'whatever'})
    expect(buildFailureCopyKey(error, 'shielded')).toBe('notReadyShielded')
    expect(buildFailureCopyKey(error, 'unshielded')).toBe('notReadyUnshielded')
  })

  it('falls back to unknown for anything that is not a build error', () => {
    // A native builder rejects with a plain developer-facing string. It belongs in the log, not in
    // front of a user, and not pattern-matched into a category it never declared.
    expect(buildFailureCopyKey(new Error('holds 0 of this token, need 500000'), 'shielded')).toBe('unknown')
    expect(buildFailureCopyKey('a string', 'shielded')).toBe('unknown')
    expect(buildFailureCopyKey(undefined, 'unshielded')).toBe('unknown')
  })

  it('never returns a cause tag, which is what leaked to the screen before', () => {
    const error = new MidnightBuildError({cause: 'not-ready', reason: 'internal wording'})
    const key = buildFailureCopyKey(error, 'shielded')
    expect(key).not.toContain(':')
    expect(key).not.toContain('not-ready')
  })
})
