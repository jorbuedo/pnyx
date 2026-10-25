import {MAX_HANDLE_BYTES, MIN_HANDLE_BYTES} from '@pnyx/contract-client/handle'
import {describe, expect, it} from 'vitest'
import {tierRanges} from './handle-tier-ranges'

describe('tierRanges', () => {
  // The boundaries Jordi set, and the ones the circuit probes (indices 2, 3, 4, 6, 10, 22). Pinned
  // here rather than defined here: if `handleTier` moves, this fails instead of the screen quietly
  // offering a length at the wrong price.
  it('matches the tier boundaries the contract enforces', () => {
    expect(tierRanges()).toEqual([
      {tier: 0, from: 1, to: 2},
      {tier: 1, from: 3, to: 3},
      {tier: 2, from: 4, to: 4},
      {tier: 3, from: 5, to: 6},
      {tier: 4, from: 7, to: 10},
      {tier: 5, from: 11, to: 22},
      {tier: 6, from: 23, to: 31},
    ])
  })

  it('covers every admissible length exactly once, with no gaps', () => {
    const ranges = tierRanges()
    expect(ranges[0]?.from).toBe(MIN_HANDLE_BYTES)
    expect(ranges[ranges.length - 1]?.to).toBe(MAX_HANDLE_BYTES)
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]?.from).toBe((ranges[i - 1]?.to ?? 0) + 1)
    }
  })

  it('is ascending and has one entry per tier', () => {
    const tiers = tierRanges().map((range) => range.tier)
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b))
    expect(new Set(tiers).size).toBe(tiers.length)
  })
})
