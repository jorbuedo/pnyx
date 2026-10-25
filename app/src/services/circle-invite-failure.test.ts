// The invite-request failure mapping.
//
// Worth its own test because it is the place the whole design collapses if it drifts: the service
// answers a refusal, an outage and an empty pool with three different statuses precisely so the
// user is not told the wrong one, and a mapping that flattened them would be invisible — every
// branch still renders *a* message.
import {describe, expect, it} from 'vitest'
import {inviteFailureFrom} from './circle-invite-failure'
import {PnyxApiError} from './pnyx-api'

describe('inviteFailureFrom', () => {
  // ⚠️ 503 is our outage. Reporting it as a verdict tells someone their wallet is wrong when we
  // never managed to look at it.
  it('reads 503 as unavailable, never as ineligible', () => {
    expect(inviteFailureFrom(new PnyxApiError(503, 'could not check'))).toEqual({kind: 'unavailable'})
  })

  // ⚠️ 409 means they qualified and the circle is out of codes — its founder's problem.
  it('reads 409 as an empty pool', () => {
    expect(inviteFailureFrom(new PnyxApiError(409, 'no invites left'))).toEqual({kind: 'none-left'})
  })

  it('reads 404 as this circle having no self-service path', () => {
    expect(inviteFailureFrom(new PnyxApiError(404, 'no policy'))).toEqual({kind: 'no-policy'})
  })

  it('reads 403 as ineligible and keeps which rule bit', () => {
    const error = new PnyxApiError(403, 'does not meet', undefined, {failure: 'below-ada-threshold'})
    expect(inviteFailureFrom(error)).toEqual({
      kind: 'not-eligible',
      reason: 'below-ada-threshold',
      // A service that sent only `failure` — the list falls back to it rather than to empty, which
      // would render a refusal with no reason at all.
      reasons: ['below-ada-threshold'],
    })
  })

  /**
   * ⚠️ Every rule's verdict, not just the first. A circle with three requirements refuses with
   * three reasons, and the one the requester can actually act on may be any of them.
   */
  it('keeps one reason per rule when the service lists them', () => {
    const error = new PnyxApiError(403, 'does not meet', undefined, {
      failure: 'stake-key-not-registered',
      failures: ['stake-key-not-registered', 'below-ada-threshold'],
    })
    expect(inviteFailureFrom(error)).toEqual({
      kind: 'not-eligible',
      reason: 'stake-key-not-registered',
      reasons: ['stake-key-not-registered', 'below-ada-threshold'],
    })
  })

  // The reason rides in the parsed body, so this pins that `PnyxApiError` still carries one — the
  // field was added for exactly this and a caller cannot tell a lost body from an absent reason.
  it('falls back to unknown when the body carries no failure code', () => {
    expect(inviteFailureFrom(new PnyxApiError(403, 'does not meet'))).toEqual({
      kind: 'not-eligible',
      reason: 'unknown',
      reasons: ['unknown'],
    })
  })

  it('reads a network failure as a generic failure rather than a verdict', () => {
    const failure = inviteFailureFrom(new PnyxApiError(undefined, 'unreachable'))
    expect(failure.kind).toBe('failed')
  })

  it('reads a non-api throw as a generic failure', () => {
    expect(inviteFailureFrom(new Error('boom')).kind).toBe('failed')
  })
})
