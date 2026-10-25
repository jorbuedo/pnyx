import {describe, expect, it} from 'vitest'
import {parseTierOffers} from './payment-wire'

const row = (tier: number, free: boolean, price: string | null) =>
  `{"tier":${tier},"free":${free},"price":${price === null ? 'null' : `"${price}"`}}`

describe('parseTierOffers', () => {
  it('reads the free flag and the price independently', () => {
    const offers = parseTierOffers(`{"tiers":[${row(5, false, '1')},${row(6, true, null)}]}`)
    expect(offers).toEqual([
      {tier: 5, free: false, price: 1n},
      {tier: 6, free: true, price: null},
    ])
  })

  // The distinction the whole shape exists for: a tier with no row in the probed currency is not free.
  it('does not read an absent price as free', () => {
    const [offer] = parseTierOffers(`{"tiers":[${row(0, false, null)}]}`)
    expect(offer?.free).toBe(false)
    expect(offer?.price).toBeNull()
  })

  // A `Uint<128>` price exceeds Number.MAX_SAFE_INTEGER, which is why the wire carries a string.
  it('keeps a price beyond 2^53 exact', () => {
    const huge = '340282366920938463463374607431768211455'
    const [offer] = parseTierOffers(`{"tiers":[${row(0, false, huge)}]}`)
    expect(offer?.price).toBe(BigInt(huge))
  })

  it('refuses a price that is a JSON number rather than a decimal string', () => {
    expect(() => parseTierOffers('{"tiers":[{"tier":0,"free":false,"price":1}]}')).toThrow(/decimal string/)
  })

  it('refuses a tier outside the contract’s range', () => {
    expect(() => parseTierOffers(`{"tiers":[${row(7, true, null)}]}`)).toThrow(/tier 0\.\.6/)
  })

  it('refuses a missing free flag rather than defaulting it', () => {
    expect(() => parseTierOffers('{"tiers":[{"tier":0,"price":null}]}')).toThrow(/non-boolean free flag/)
  })

  it('refuses an answer that is not a tiers array', () => {
    expect(() => parseTierOffers('{}')).toThrow(/tiers array/)
  })
})
