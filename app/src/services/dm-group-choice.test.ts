import {describe, expect, it} from 'vitest'

import {chooseGroup, compareGroupIds} from './dm-group-choice'

const id = (...bytes: number[]): Uint8Array => new Uint8Array(bytes)

describe('compareGroupIds', () => {
  it('gives both devices the same answer for the same pair', () => {
    // The property the whole tie-break rests on: computed independently, agreed without exchanging
    // anything. A rule that were merely deterministic *per device* would let two devices swap
    // groups for ever, which is the failure it exists to prevent.
    expect(compareGroupIds(id(1, 2, 3), id(1, 2, 4))).toBeLessThan(0)
    expect(compareGroupIds(id(1, 2, 4), id(1, 2, 3))).toBeGreaterThan(0)
  })

  it('is a total order, so no pair is ever undecided', () => {
    expect(compareGroupIds(id(9, 9), id(9, 9))).toBe(0)
  })
})

describe('chooseGroup', () => {
  const OURS = id(1, 1, 1)
  const THEIRS = id(2, 2, 2)

  it('calls a Welcome for our own group a duplicate', () => {
    expect(chooseGroup(OURS, OURS, false)).toBe('duplicate')
    expect(chooseGroup(OURS, OURS, true)).toBe('duplicate')
  })

  it('adopts a different group when we are not repairing, whichever way it sorts', () => {
    // The one-sided repair, and the case the old code got wrong by ignoring the Welcome entirely.
    // Ours is the broken group; sort order must not enter into it, or a repair whose new id happens
    // to sort higher would be refused and the break would be unfixable from the peer's side.
    expect(chooseGroup(OURS, THEIRS, false)).toBe('adopt')
    expect(chooseGroup(THEIRS, OURS, false)).toBe('adopt')
  })

  it('keeps ours when we are also repairing and ours sorts first', () => {
    expect(chooseGroup(OURS, THEIRS, true)).toBe('keep')
  })

  it('adopts when we are also repairing and theirs sorts first', () => {
    expect(chooseGroup(THEIRS, OURS, true)).toBe('adopt')
  })

  it('converges two devices that repaired at the same moment', () => {
    // Both rebuilt, both sent a Welcome, both have the marker set. Played from each side: exactly
    // one keeps and one adopts, so they end in the same group rather than swapping.
    const alice = chooseGroup(OURS, THEIRS, true)
    const bob = chooseGroup(THEIRS, OURS, true)
    expect([alice, bob].sort()).toEqual(['adopt', 'keep'])
  })
})
