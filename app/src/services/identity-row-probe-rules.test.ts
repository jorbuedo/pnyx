import {describe, expect, it} from 'vitest'
import {cacheVerdict, isUnclaimedName, probeTarget} from './identity-row-probe-rules'

const ADDRESS = '92a592d617f83184c29fa2a5f1460c5bdcf67f474d51e3cec5243216f46a7128'

describe('probeTarget', () => {
  it('reads the network the service is deployed against', () => {
    expect(probeTarget('preprod', 'preprod', ADDRESS)).toEqual({kind: 'readable', address: ADDRESS})
  })

  it('reports the other network as not-deployed-there, naming where it is', () => {
    // The honest answer for mainnet today: there is no Pnyx contract on it, so no address exists to
    // read one at. Naming the configured network is what makes the line actionable.
    expect(probeTarget('mainnet', 'preprod', ADDRESS)).toEqual({kind: 'other-network', configuredNetwork: 'preprod'})
  })

  it('follows a redeploy to a different chain instead of hardcoding which network works', () => {
    // Nothing in the rule knows "preprod is the real one" — swap the config and the answer swaps.
    expect(probeTarget('mainnet', 'mainnet', ADDRESS)).toEqual({kind: 'readable', address: ADDRESS})
    expect(probeTarget('preprod', 'mainnet', ADDRESS)).toEqual({kind: 'other-network', configuredNetwork: 'mainnet'})
  })

  it('reports unknown — never "not deployed" — when the service never answered', () => {
    // The distinction this module exists for: an unreachable service is no evidence about where the
    // contract is, so it must not render as a claim that Pnyx is absent from this network.
    for (const network of ['mainnet', 'preprod']) {
      expect(probeTarget(network, null, null)).toEqual({kind: 'unknown'})
      expect(probeTarget(network, null, ADDRESS)).toEqual({kind: 'unknown'})
    }
  })

  it('treats a matching network with no usable address as unknown, not as readable', () => {
    // A build whose service has no chain configured: it answered, but said nothing about a contract.
    expect(probeTarget('preprod', 'preprod', null)).toEqual({kind: 'unknown'})
    expect(probeTarget('preprod', 'preprod', '')).toEqual({kind: 'unknown'})
  })
})

describe('isUnclaimedName', () => {
  it('treats the all-zero field as unclaimed', () => {
    expect(isUnclaimedName(new Uint8Array(32))).toBe(true)
  })

  it('treats any set byte as a claim, including one in the last position', () => {
    const trailing = new Uint8Array(32)
    trailing[31] = 1
    expect(isUnclaimedName(trailing)).toBe(false)

    const leading = new Uint8Array(32)
    leading[0] = 0xff
    expect(isUnclaimedName(leading)).toBe(false)
  })
})

describe('cacheVerdict', () => {
  it('flags a cached flag with no row as stale — the state that makes login fail silently', () => {
    expect(cacheVerdict(true, false)).toBe('stale')
  })

  it('reports agreement in both directions', () => {
    expect(cacheVerdict(true, true)).toBe('agree')
    expect(cacheVerdict(false, false)).toBe('agree-absent')
  })

  it('treats a row that is not cached yet as benign', () => {
    // The next successful login records it; nothing is broken.
    expect(cacheVerdict(false, true)).toBe('uncached')
  })
})
