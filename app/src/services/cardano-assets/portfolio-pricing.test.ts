import {describe, expect, it} from 'vitest'
import {isAuthoritativePass, isPaintableCache} from './portfolio-pricing'

describe('isAuthoritativePass', () => {
  it('accepts a priced pass on a fiat network', () => {
    expect(isAuthoritativePass(0.42, true)).toBe(true)
  })

  it('rejects an unpriced pass on a fiat network (price source is down)', () => {
    expect(isAuthoritativePass(null, true)).toBe(false)
  })

  it('accepts an unpriced pass on a network with no fiat', () => {
    // The preprod regression: without this, the cold pre-sync balance (zero) is
    // the first writer and every synced balance after it is discarded.
    expect(isAuthoritativePass(null, false)).toBe(true)
  })

  it('treats a zero rate as a real rate, not a missing one', () => {
    expect(isAuthoritativePass(0, true)).toBe(true)
  })
})

describe('isPaintableCache', () => {
  it('paints a priced snapshot on a fiat network', () => {
    expect(isPaintableCache([{usdValue: 0}, {usdValue: 12.5}], true)).toBe(true)
  })

  it('refuses an all-zero snapshot on a fiat network', () => {
    expect(isPaintableCache([{usdValue: 0}, {usdValue: 0}], true)).toBe(false)
  })

  it('paints an all-zero snapshot on a network with no fiat', () => {
    expect(isPaintableCache([{usdValue: 0}, {usdValue: 0}], false)).toBe(true)
  })

  it('refuses an empty snapshot on either network', () => {
    expect(isPaintableCache([], true)).toBe(false)
    expect(isPaintableCache([], false)).toBe(false)
  })
})
