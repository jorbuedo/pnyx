import {describe, expect, it} from 'vitest'
import {confirmationsFor} from './confirmations'

describe('confirmationsFor', () => {
  it("counts the transaction's own block as the first confirmation", () => {
    expect(confirmationsFor(13_728_487, 13_728_487)).toBe(1)
    expect(confirmationsFor(13_728_490, 13_728_487)).toBe(4)
  })

  it('reports nothing when either height is unknown', () => {
    expect(confirmationsFor(null, 13_728_487)).toBeNull()
    expect(confirmationsFor(13_728_487, undefined)).toBeNull()
    expect(confirmationsFor(null, undefined)).toBeNull()
  })

  it('refuses a tip behind the transaction rather than reporting 0 or negative', () => {
    // A stale tip read, or one from another network. Either way the honest answer
    // is "unknown", not a count that understates how settled the tx is.
    expect(confirmationsFor(13_728_486, 13_728_487)).toBeNull()
    expect(confirmationsFor(1, 13_728_487)).toBeNull()
  })

  it('refuses non-finite heights', () => {
    expect(confirmationsFor(Number.NaN, 1)).toBeNull()
    expect(confirmationsFor(1, Number.NaN)).toBeNull()
    expect(confirmationsFor(Number.POSITIVE_INFINITY, 1)).toBeNull()
  })
})
