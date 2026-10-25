import {describe, expect, it} from 'vitest'
import {type HeldNameStatus, mergeHeldNames} from './held-names'

const owned = (): HeldNameStatus => 'owned'

describe('mergeHeldNames', () => {
  it('lists the name the row shows, marked active', () => {
    const names = mergeHeldNames({activeName: 'alpha', statusOf: owned})
    expect(names.map((n) => n.canonical)).toEqual(['alpha'])
    expect(names[0]?.active).toBe(true)
  })

  it('has nothing to list when the row names nothing', () => {
    expect(mergeHeldNames({activeName: undefined, statusOf: owned})).toEqual([])
  })

  it('carries the status the caller resolved', () => {
    const names = mergeHeldNames({activeName: 'alpha', statusOf: () => 'not-owned'})
    expect(names[0]?.status).toBe('not-owned')
  })

  // ⚠️ `unknown` is not `not-owned`: an outage must not tell someone a name they hold is not theirs.
  it('passes an unknown status through rather than collapsing it', () => {
    const names = mergeHeldNames({activeName: 'alpha', statusOf: () => 'unknown'})
    expect(names[0]?.status).toBe('unknown')
  })

  it('keeps the display spelling while folding the canonical one', () => {
    const names = mergeHeldNames({activeName: 'Alpha', statusOf: owned})
    expect(names[0]?.display).toBe('Alpha')
    expect(names[0]?.canonical).toBe('alpha')
  })

  // A row naming bytes that are not a claimable name cannot be a name this identity holds.
  it('drops a name that is not valid', () => {
    expect(mergeHeldNames({activeName: 'alice.bob', statusOf: owned})).toEqual([])
    expect(mergeHeldNames({activeName: '  ', statusOf: owned})).toEqual([])
  })
})
