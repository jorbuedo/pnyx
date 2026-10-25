import {describe, expect, it} from 'vitest'

import {getNetworkRule, getNetworkRules, type RemoteConfig} from './remote-config.js'

// `exactOptionalPropertyTypes` is on, so an optional property cannot be *assigned* `undefined`.
// Build the object without the key rather than with an undefined one.
const config = (networks: RemoteConfig['networks']): RemoteConfig => (networks === undefined ? {} : {networks})

describe('getNetworkRules', () => {
  it('reads the matrix the control plane published', () => {
    const rules = getNetworkRules(config({midnight: {mainnet: {enabled: false}}}))
    expect(rules?.midnight?.mainnet?.enabled).toBe(false)
  })

  it('is undefined when the control plane says nothing, so callers fall back rather than shut down', () => {
    expect(getNetworkRules(undefined)).toBeUndefined()
    expect(getNetworkRules({})).toBeUndefined()
  })
})

describe('getNetworkRule', () => {
  it('addresses one chain on one network', () => {
    const c = config({
      midnight: {mainnet: {enabled: false, reasonCode: 'decommissioned'}, preprod: {enabled: true}},
      cardano: {preview: {enabled: false}},
    })
    expect(getNetworkRule(c, 'midnight', 'mainnet')).toEqual({enabled: false, reasonCode: 'decommissioned'})
    expect(getNetworkRule(c, 'midnight', 'preprod')).toEqual({enabled: true})
    expect(getNetworkRule(c, 'cardano', 'preview')?.enabled).toBe(false)
  })

  it('does not leak one chain’s rule to the other, nor one network’s to its neighbour', () => {
    const c = config({midnight: {mainnet: {enabled: false}}})
    expect(getNetworkRule(c, 'cardano', 'mainnet')).toBeUndefined()
    expect(getNetworkRule(c, 'midnight', 'preprod')).toBeUndefined()
  })

  it('carries endpoint overrides per network', () => {
    const c = config({
      midnight: {
        mainnet: {endpoints: {indexer: 'https://midnight.example.com/api/v4/graphql'}},
      },
    })
    expect(getNetworkRule(c, 'midnight', 'mainnet')?.endpoints?.indexer).toBe(
      'https://midnight.example.com/api/v4/graphql',
    )
    expect(getNetworkRule(c, 'midnight', 'mainnet')?.endpoints?.node).toBeUndefined()
  })
})
