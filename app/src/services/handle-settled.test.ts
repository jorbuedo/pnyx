import {describe, expect, it} from 'vitest'
import {claimSettled, releaseSettled} from './handle-settled'

const NAME = 'Sablewind-Harborlighted'
const FOLDED = 'sablewind-harborlighted'

describe('claimSettled', () => {
  // ⚠️ The regression this module exists for: the row carries the display spelling, the claim is for the
  // folded name, and a string comparison never settles — the claim lands and the UI says it did not.
  it('settles when the row holds the display spelling of the claimed name', () => {
    expect(claimSettled(NAME, NAME)).toBe(true)
    expect(claimSettled(NAME, FOLDED)).toBe(true)
    expect(claimSettled(FOLDED, NAME)).toBe(true)
  })

  it('does not settle while the row holds nothing', () => {
    expect(claimSettled(undefined, NAME)).toBe(false)
  })

  it('does not settle on somebody else’s name', () => {
    expect(claimSettled('someotherlongenoughname', NAME)).toBe(false)
  })

  // A claim that could never have been made must not report success.
  it('does not settle an unclaimable name', () => {
    expect(claimSettled('Not A Name!', 'Not A Name!')).toBe(false)
  })
})

describe('releaseSettled', () => {
  it('settles only when the row holds no name', () => {
    expect(releaseSettled(undefined)).toBe(true)
    expect(releaseSettled(NAME)).toBe(false)
  })
})
