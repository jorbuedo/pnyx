import {describe, expect, it} from 'vitest'

import {
  midnightExplorerAddressUrl,
  midnightExplorerBlockUrl,
  midnightExplorerContractUrl,
  midnightExplorerHost,
  midnightExplorerTxUrl,
} from './explorer'

describe('midnightExplorerHost', () => {
  it('gives each network its own host, because the network is baked into the deployment', () => {
    // Pointing a preprod hash at `www` would render "not found" and read as a lost transaction.
    expect(midnightExplorerHost('mainnet')).toBe('https://www.midnightexplorer.com')
    expect(midnightExplorerHost('preprod')).toBe('https://preprod.midnightexplorer.com')
    expect(midnightExplorerHost('preview')).toBe('https://preview.midnightexplorer.com')
  })

  it('has no host for a local chain or an unknown name, rather than defaulting to mainnet', () => {
    for (const network of ['undeployed', 'devnet', 'qanet', '', null]) {
      expect(midnightExplorerHost(network)).toBeNull()
    }
  })
})

describe('link builders', () => {
  it("build the app's own route templates", () => {
    expect(midnightExplorerTxUrl('preprod', 'deadbeef')).toBe(
      'https://preprod.midnightexplorer.com/transactions/deadbeef',
    )
    expect(midnightExplorerAddressUrl('mainnet', 'mn_addr1abc')).toBe(
      'https://www.midnightexplorer.com/address/mn_addr1abc',
    )
    expect(midnightExplorerContractUrl('preprod', '0200abc')).toBe(
      'https://preprod.midnightexplorer.com/contracts/0200abc',
    )
    expect(midnightExplorerBlockUrl('preprod', 2_176_000)).toBe('https://preprod.midnightexplorer.com/blocks/2176000')
  })

  it('refuse to build a link with nothing to point at', () => {
    expect(midnightExplorerTxUrl('preprod', '')).toBeNull()
    expect(midnightExplorerAddressUrl('preprod', '')).toBeNull()
    expect(midnightExplorerContractUrl('preprod', '')).toBeNull()
    expect(midnightExplorerBlockUrl('preprod', -1)).toBeNull()
    expect(midnightExplorerBlockUrl('preprod', 1.5)).toBeNull()
  })

  it('refuse to build a link for a network with no explorer', () => {
    expect(midnightExplorerTxUrl('undeployed', 'deadbeef')).toBeNull()
    expect(midnightExplorerAddressUrl(null, 'mn_addr1abc')).toBeNull()
  })
})
