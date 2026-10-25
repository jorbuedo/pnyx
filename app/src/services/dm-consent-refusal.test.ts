import {describe, expect, it} from 'vitest'
import {DmApiError} from './dm-api'
import {consentRefusalOf} from './dm-consent-refusal'

describe('consentRefusalOf', () => {
  it('reads a permit-only inbox as its own case, so the user can be told to ask', () => {
    expect(consentRefusalOf(new DmApiError(403, 'that identity accepts messages by permit only'))).toBe(
      'permit-required',
    )
  })

  // ⚠️ A block and a closed inbox are one outcome on purpose: the wire does not distinguish them,
  // and inventing the difference here would leak what the blocker chose not to disclose.
  it('reads a block and a closed inbox as the same refusal', () => {
    expect(consentRefusalOf(new DmApiError(403, 'that identity is not accepting messages from you'))).toBe(
      'peer-refuses',
    )
  })

  // Everything else is a different fact, and reporting it as a refusal would say something false
  // about another person.
  it('is not a refusal for any other status', () => {
    for (const status of [400, 401, 404, 409, 429, 500]) {
      expect(consentRefusalOf(new DmApiError(status, 'nope'))).toBeUndefined()
    }
  })

  it('is not a refusal when the service was unreachable, or the error is not ours', () => {
    expect(consentRefusalOf(new DmApiError(undefined, 'content service unreachable'))).toBeUndefined()
    expect(consentRefusalOf(new Error('boom'))).toBeUndefined()
    expect(consentRefusalOf('boom')).toBeUndefined()
  })
})
