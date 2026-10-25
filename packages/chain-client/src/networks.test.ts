/**
 * Per-network endpoints and network-id validation.
 *
 * Both used to degrade silently for anything that was not `undeployed` or `preprod`: endpoints fell
 * back to 127.0.0.1 and the wallet network id fell back to PreProd. A `mainnet` client therefore read
 * an empty local chain and signed with the wrong id, which surfaces as "nothing is deployed" and an
 * opaque node rejection rather than as the misconfiguration it is.
 */

import {describe, expect, it} from 'vitest'
import {networkDefaults, walletNetworkIdFor} from './client'

describe('networkDefaults', () => {
  it('serves the official mainnet rail', () => {
    expect(networkDefaults('mainnet')).toEqual({
      indexer: 'https://midnight-mainnet.pxkq.uk/api/v4/graphql',
      indexerWS: 'wss://midnight-mainnet.pxkq.uk/api/v4/graphql/ws',
      node: 'https://rpc.mainnet.midnight.network',
      nodeWS: 'wss://rpc.mainnet.midnight.network',
    })
  })

  it('serves the official preprod rail', () => {
    expect(networkDefaults('preprod').node).toBe('https://rpc.preprod.midnight.network')
  })

  it('points the local chain at the standalone stack', () => {
    expect(networkDefaults('undeployed').node).toBe('http://127.0.0.1:9944')
  })

  // The regression that matters: a real network must never resolve to loopback.
  it.each([['mainnet'], ['preprod']])('never points %s at localhost', (network) => {
    for (const url of Object.values(networkDefaults(network))) {
      expect(url).not.toMatch(/127\.0\.0\.1|localhost/)
    }
  })

  it('throws for a network it has no endpoints for, naming the known ones', () => {
    expect(() => networkDefaults('testnet')).toThrow(/no Midnight endpoints for network 'testnet'/)
    expect(() => networkDefaults('testnet')).toThrow(/mainnet, preprod, preview, undeployed/)
  })
})

describe('walletNetworkIdFor', () => {
  // The SDK's enum values are the network strings themselves, so this validates rather than maps.
  it.each([['mainnet'], ['preprod'], ['undeployed'], ['testnet'], ['preview']])('accepts %s', (network) => {
    expect(walletNetworkIdFor(network)).toBe(network)
  })

  it('rejects a string that is not a network id', () => {
    expect(() => walletNetworkIdFor('preprodd')).toThrow(/is not a Midnight network id/)
  })
})
