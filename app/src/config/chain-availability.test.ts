import type {RemoteNetworksConfig} from '@pnyx/config'
import {describe, expect, it} from 'vitest'

import {chainAvailability, isChainUsable, remoteMidnightEndpoints, usableNetworks} from './chain-availability'

const ALL = ['mainnet', 'preprod', 'preview'] as const

describe('chainAvailability', () => {
  it('is usable when the control plane says nothing at all', () => {
    expect(chainAvailability(undefined, 'midnight', 'mainnet')).toEqual({usable: true, reasonCode: null})
    expect(chainAvailability({}, 'midnight', 'mainnet').usable).toBe(true)
  })

  it('is usable when an entry exists but only carries endpoints', () => {
    const rules: RemoteNetworksConfig = {midnight: {mainnet: {endpoints: {indexer: 'https://example.com/graphql'}}}}
    expect(chainAvailability(rules, 'midnight', 'mainnet').usable).toBe(true)
  })

  it('only an explicit false takes a network away', () => {
    expect(chainAvailability({midnight: {mainnet: {enabled: true}}}, 'midnight', 'mainnet').usable).toBe(true)
    expect(chainAvailability({midnight: {mainnet: {enabled: false}}}, 'midnight', 'mainnet').usable).toBe(false)
  })

  it('carries the published reason, and names one when the control plane did not', () => {
    expect(
      chainAvailability({midnight: {mainnet: {enabled: false, reasonCode: 'decommissioned'}}}, 'midnight', 'mainnet'),
    ).toEqual({usable: false, reasonCode: 'decommissioned'})
    expect(chainAvailability({midnight: {mainnet: {enabled: false}}}, 'midnight', 'mainnet').reasonCode).toBe(
      'unspecified',
    )
    expect(
      chainAvailability({midnight: {mainnet: {enabled: false, reasonCode: ''}}}, 'midnight', 'mainnet').reasonCode,
    ).toBe('unspecified')
  })

  it('shuts one pair without touching its neighbours — the 2026-09-30 shape', () => {
    // Midnight mainnet's indexer was decommissioned while preprod kept serving and Cardano was
    // untouched. One entry has to express exactly that and nothing wider.
    const rules: RemoteNetworksConfig = {midnight: {mainnet: {enabled: false, reasonCode: 'decommissioned'}}}
    expect(isChainUsable(rules, 'midnight', 'mainnet')).toBe(false)
    expect(isChainUsable(rules, 'midnight', 'preprod')).toBe(true)
    expect(isChainUsable(rules, 'midnight', 'preview')).toBe(true)
    expect(isChainUsable(rules, 'cardano', 'mainnet')).toBe(true)
  })
})

describe('usableNetworks', () => {
  it('keeps the given order and drops only what is disabled', () => {
    const rules: RemoteNetworksConfig = {cardano: {preview: {enabled: false}}}
    expect(usableNetworks(rules, 'cardano', ALL)).toEqual(['mainnet', 'preprod'])
    expect(usableNetworks(rules, 'midnight', ALL)).toEqual([...ALL])
  })

  it('can return nothing, and does not invent a fallback', () => {
    const rules: RemoteNetworksConfig = {
      midnight: {mainnet: {enabled: false}, preprod: {enabled: false}, preview: {enabled: false}},
    }
    expect(usableNetworks(rules, 'midnight', ALL)).toEqual([])
  })
})

describe('remoteMidnightEndpoints', () => {
  it('reads the published defaults for a network', () => {
    const rules: RemoteNetworksConfig = {midnight: {preprod: {endpoints: {node: 'https://rpc.example.com'}}}}
    expect(remoteMidnightEndpoints(rules, 'preprod')).toEqual({node: 'https://rpc.example.com'})
    expect(remoteMidnightEndpoints(rules, 'mainnet')).toBeUndefined()
  })

  it('still reports endpoints for a network that is switched off', () => {
    const rules: RemoteNetworksConfig = {
      midnight: {mainnet: {enabled: false, endpoints: {indexer: 'https://example.com/graphql'}}},
    }
    expect(remoteMidnightEndpoints(rules, 'mainnet')?.indexer).toBe('https://example.com/graphql')
  })
})
