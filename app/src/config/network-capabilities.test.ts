import type {Network} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {adaTickerFor, isTestnetNetwork, networkCapabilities} from './network-capabilities'

const ALL: readonly Network[] = ['mainnet', 'preprod', 'preview']

describe('networkCapabilities', () => {
  it('enables prices and swap only on mainnet', () => {
    expect(networkCapabilities('mainnet')).toEqual({
      isTestnet: false,
      showFiat: true,
      swapEnabled: true,
      priceHistory: true,
      adaTicker: 'ADA',
    })
  })

  it('treats both Cardano testnets identically', () => {
    expect(networkCapabilities('preprod')).toEqual(networkCapabilities('preview'))
  })

  it.each(['preprod', 'preview'] as const)('withholds every price-shaped capability on %s', (network) => {
    const caps = networkCapabilities(network)
    expect(caps.isTestnet).toBe(true)
    expect(caps.showFiat).toBe(false)
    expect(caps.swapEnabled).toBe(false)
    // The chart's sources quote mainnet assets only, so on a testnet it must not even be attempted:
    // it used to mount, show a skeleton, and withdraw when the empty series came back.
    expect(caps.priceHistory).toBe(false)
    expect(caps.adaTicker).toBe('tADA')
  })

  it('never reports fiat without swap or vice versa — both follow mainnet', () => {
    for (const network of ALL) {
      const caps = networkCapabilities(network)
      expect(caps.showFiat).toBe(caps.swapEnabled)
      expect(caps.showFiat).toBe(caps.priceHistory)
    }
  })
})

describe('isTestnetNetwork', () => {
  it.each(ALL)('agrees with the capability table for %s', (network) => {
    expect(isTestnetNetwork(network)).toBe(networkCapabilities(network).isTestnet)
  })
})

describe('adaTickerFor', () => {
  it('labels mainnet ADA and testnets tADA', () => {
    expect(adaTickerFor('mainnet')).toBe('ADA')
    expect(adaTickerFor('preprod')).toBe('tADA')
    expect(adaTickerFor('preview')).toBe('tADA')
  })
})
