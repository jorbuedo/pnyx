import {permitTokenType} from '@pnyx/contract-client/derivations'
import {hex} from '@pnyx/crypto'
import {describe, expect, it} from 'vitest'
import {permitColours, TIERS, tallyPermits} from './permit-balances'

const PAYMENT = new Uint8Array(32).fill(0x11)
const colourOf = (tier: number) => hex.encode(permitTokenType(PAYMENT, tier))

describe('permitColours', () => {
  it('gives one distinct colour per tier', () => {
    const byColour = permitColours(PAYMENT)
    expect(byColour.size).toBe(TIERS.length)
    expect(new Set(byColour.values())).toEqual(new Set(TIERS))
  })

  // The colour seals the payment contract, so permits from a superseded deployment must not be
  // counted. A handle's address seals the payment address too, which is why the `test` handle from an
  // earlier payment contract is orphaned rather than merely stale.
  it('is specific to the payment contract', () => {
    const other = permitColours(new Uint8Array(32).fill(0x12))
    for (const colour of permitColours(PAYMENT).keys()) expect(other.has(colour)).toBe(false)
  })
})

describe('tallyPermits', () => {
  const byColour = permitColours(PAYMENT)

  it('counts a permit under its own tier', () => {
    const tally = tallyPermits(new Map([[colourOf(4), 2n]]), byColour)
    expect(tally.get(4)).toBe(2n)
    expect(tally.size).toBe(1)
  })

  // ⚠️ `bind` accepts only the name's own tier, so counting a t0 permit toward a t3 name would offer a
  // claim that cannot prove.
  it('never counts one tier toward another', () => {
    const tally = tallyPermits(new Map([[colourOf(0), 5n]]), byColour)
    expect(tally.get(3)).toBeUndefined()
    expect(tally.get(0)).toBe(5n)
  })

  it('ignores every token that is not a permit', () => {
    const tally = tallyPermits(
      new Map([
        ['00'.repeat(32), 1_000_000n], // NIGHT
        ['ab'.repeat(32), 7n],
        [colourOf(6), 1n],
      ]),
      byColour,
    )
    expect([...tally.keys()]).toEqual([6])
  })

  it('matches a colour whatever case the store reports it in', () => {
    const tally = tallyPermits(new Map([[colourOf(2).toUpperCase(), 1n]]), byColour)
    expect(tally.get(2)).toBe(1n)
  })

  // A zero-valued row is not a holding, and a negative one is a bug upstream rather than a debt.
  it('does not report a zero or negative total as held', () => {
    expect(tallyPermits(new Map([[colourOf(1), 0n]]), byColour).size).toBe(0)
    expect(tallyPermits(new Map([[colourOf(1), -1n]]), byColour).size).toBe(0)
  })

  it('sums several holdings of one tier', () => {
    // One map cannot hold the same key twice, so this is the cross-wallet shape: two tallies added.
    const a = tallyPermits(new Map([[colourOf(5), 2n]]), byColour)
    const b = tallyPermits(new Map([[colourOf(5), 3n]]), byColour)
    expect((a.get(5) ?? 0n) + (b.get(5) ?? 0n)).toBe(5n)
  })
})
