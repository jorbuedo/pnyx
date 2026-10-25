import {describe, expect, it} from 'vitest'
import {offerFor} from './handle-offer-rule'

// The live preprod policy: tier 6 free, tier 5 priced in NIGHT, 0–4 closed.
const PREPROD = {
  kind: 'offers',
  offers: [
    {tier: 0, free: false, price: null},
    {tier: 1, free: false, price: null},
    {tier: 2, free: false, price: null},
    {tier: 3, free: false, price: null},
    {tier: 4, free: false, price: null},
    {tier: 5, free: false, price: 1n},
    {tier: 6, free: true, price: null},
  ],
} as const

describe('offerFor', () => {
  // 23–31 bytes is tier 6, the free one.
  it('offers a long name for free', () => {
    expect(offerFor('averyverylongnamethatfits', PREPROD)).toEqual({kind: 'free', tier: 6})
  })

  // 11–22 bytes is tier 5, priced.
  it('reports a mid-length name as priced rather than free', () => {
    expect(offerFor('elevenchars', PREPROD)).toEqual({kind: 'priced', tier: 5, price: 1n})
  })

  it('reports a short name as unavailable, not as an error', () => {
    expect(offerFor('bob', PREPROD)).toEqual({kind: 'unavailable', tier: 1})
  })

  it('reports an invalid name before consulting the chain at all', () => {
    const offer = offerFor('Not A Name!', PREPROD)
    expect(offer.kind).toBe('invalid')
  })

  // ⚠️ The distinction the type exists for. A failed read must not render as "you cannot have it".
  it('keeps "could not read" distinct from "closed"', () => {
    const offer = offerFor('averyverylongnamethatfits', {kind: 'unreadable', detail: 'indexer down'})
    expect(offer.kind).toBe('unknown')
    expect(offer.kind).not.toBe('unavailable')
  })

  it('says the build has no namespace rather than blaming the name', () => {
    expect(offerFor('averyverylongnamethatfits', {kind: 'no-namespace'})).toEqual({kind: 'no-namespace'})
  })

  // A name the chain reports no row for is a decoder disagreeing with handleTier, not a closed tier.
  it('reports a missing tier row as unknown', () => {
    const partial = {kind: 'offers', offers: [{tier: 0, free: false, price: null}]} as const
    const offer = offerFor('averyverylongnamethatfits', partial)
    expect(offer.kind).toBe('unknown')
    expect(offer.kind === 'unknown' ? offer.detail : '').toContain('tier 6')
  })

  // A tier carrying both rows is a giveaway, not a sale.
  it('prefers free over a price when a tier carries both', () => {
    const both = {kind: 'offers', offers: [{tier: 6, free: true, price: 500n}]} as const
    expect(offerFor('averyverylongnamethatfits', both)).toEqual({kind: 'free', tier: 6})
  })

  it('does not read a zero price as free', () => {
    const zero = {kind: 'offers', offers: [{tier: 6, free: false, price: 0n}]} as const
    expect(offerFor('averyverylongnamethatfits', zero)).toEqual({kind: 'priced', tier: 6, price: 0n})
  })
})

describe('offerFor — what the name’s own contract says', () => {
  // ⚠️ The case two preprod names were stuck in. `bind` landed, `setPrimaryName` did not, and the
  // storefront priced the *tier* — which for `test` (4 bytes, tier 2) is closed — so the owner could not finish
  // a claim that needed no purchase at all. `yours` is claimable; `unavailable` was not.
  it('offers to finish a name this identity already holds, whatever the tier says', () => {
    expect(offerFor('test', PREPROD, 'mine')).toEqual({kind: 'yours', tier: 2})
    expect(offerFor('averyverylongnamethatfits', PREPROD, 'mine')).toEqual({kind: 'yours', tier: 6})
    // The tier this name sits in is closed, and it makes no difference: nothing is being bought.
    expect(offerFor('test', PREPROD)).toEqual({kind: 'unavailable', tier: 2})
  })

  // Refused before a proof rather than after one: the free tier would otherwise offer a button that
  // builds a `bind` the chain then rejects.
  it('refuses a name somebody else holds instead of offering it free', () => {
    expect(offerFor('averyverylongnamethatfits', PREPROD, 'someone-else')).toEqual({kind: 'taken', tier: 6})
  })

  it('separates a ban from a burn, because only one can ever be undone', () => {
    expect(offerFor('averyverylongnamethatfits', PREPROD, 'banned')).toEqual({
      kind: 'reserved',
      tier: 6,
      permanent: false,
    })
    expect(offerFor('averyverylongnamethatfits', PREPROD, 'burned')).toEqual({
      kind: 'reserved',
      tier: 6,
      permanent: true,
    })
  })

  // An unreadable handle contract must not block a claim: the chain refuses a taken name anyway, and
  // refusing here would turn an indexer outage into "you cannot have this name".
  it('falls through to the price list when nobody could be asked', () => {
    expect(offerFor('averyverylongnamethatfits', PREPROD, 'unknown')).toEqual({kind: 'free', tier: 6})
    expect(offerFor('averyverylongnamethatfits', PREPROD, 'unbound')).toEqual({kind: 'free', tier: 6})
  })

  // The name still has to be one this client will render — that is decided before any chain read, so a
  // held-name answer cannot smuggle an unrenderable name past it.
  it('still rejects an invalid name before consulting anything', () => {
    expect(offerFor('', PREPROD, 'mine').kind).toBe('invalid')
  })
})
