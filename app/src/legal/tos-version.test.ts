import {describe, expect, it} from 'vitest'
import {TOS_PINNED_AT} from './tos-version'

describe('TOS_PINNED_AT', () => {
  it('is a finite ms-since-epoch integer', () => {
    expect(typeof TOS_PINNED_AT).toBe('number')
    expect(Number.isFinite(TOS_PINNED_AT)).toBe(true)
    expect(Number.isInteger(TOS_PINNED_AT)).toBe(true)
  })

  it('is in the past relative to "now"', () => {
    expect(TOS_PINNED_AT).toBeLessThanOrEqual(Date.now())
  })

  it('is a plausible UTC timestamp (after 2024, before year 3000)', () => {
    const minMs = Date.UTC(2024, 0, 1)
    const maxMs = Date.UTC(3000, 0, 1)
    expect(TOS_PINNED_AT).toBeGreaterThan(minMs)
    expect(TOS_PINNED_AT).toBeLessThan(maxMs)
  })
})
