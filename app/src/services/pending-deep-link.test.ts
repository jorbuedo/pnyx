import {describe, expect, it} from 'vitest'
import {isDeepLinkFresh} from './pending-deep-link'

const TTL_MS = 5 * 60_000

describe('isDeepLinkFresh', () => {
  it('keeps a link parked moments ago', () => {
    expect(isDeepLinkFresh(1_000, 1_000)).toBe(true)
    expect(isDeepLinkFresh(1_000, 1_000 + 30_000)).toBe(true)
  })

  it('keeps a link exactly at the boundary', () => {
    expect(isDeepLinkFresh(0, TTL_MS)).toBe(true)
  })

  it('drops a link past the window rather than replaying it late', () => {
    // A link handed over during one session must not fire in a later one.
    expect(isDeepLinkFresh(0, TTL_MS + 1)).toBe(false)
  })
})
