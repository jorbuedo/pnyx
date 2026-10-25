import {describe, expect, it} from 'vitest'
import {
  cardanoChainId,
  cardanoNetworkOf,
  chainIdFromCip34,
  cip34Of,
  isCardanoChainId,
  normalizeCardanoChainId,
} from './cardano-chain-id.js'

describe('canonical Cardano chain ids', () => {
  it('round-trips every network', () => {
    for (const network of ['mainnet', 'preprod', 'preview'] as const) {
      expect(cardanoNetworkOf(cardanoChainId(network))).toBe(network)
    }
  })

  it('round-trips through CIP-34', () => {
    for (const network of ['mainnet', 'preprod', 'preview'] as const) {
      const canonical = cardanoChainId(network)
      expect(chainIdFromCip34(cip34Of(canonical))).toBe(canonical)
    }
  })

  it('emits the CIP-34 spelling the co-sign envelope used', () => {
    expect(cip34Of('cardano:mainnet')).toBe('cip34:1-764824073')
    expect(cip34Of('cardano:preprod')).toBe('cip34:0-1')
    expect(cip34Of('cardano:preview')).toBe('cip34:0-2')
  })
})

describe('chainIdFromCip34', () => {
  it('separates preprod from preview by protocol magic, not network id', () => {
    // Both testnets are networkId 0; only the magic distinguishes them.
    expect(chainIdFromCip34('cip34:0-1')).toBe('cardano:preprod')
    expect(chainIdFromCip34('cip34:0-2')).toBe('cardano:preview')
  })

  it('refuses a testnet whose magic it does not recognise', () => {
    // Guessing "networkId 0 means preprod" would mislabel a private testnet as preprod.
    expect(chainIdFromCip34('cip34:0-42')).toBeNull()
  })

  it('refuses mainnet network id with the wrong magic', () => {
    expect(chainIdFromCip34('cip34:1-1')).toBeNull()
  })

  it('refuses anything that is not a CIP-34 id', () => {
    expect(chainIdFromCip34('cardano:mainnet')).toBeNull()
    expect(chainIdFromCip34('cip34:')).toBeNull()
    expect(chainIdFromCip34('cip34:1')).toBeNull()
    expect(chainIdFromCip34('cip34:a-b')).toBeNull()
    expect(chainIdFromCip34('')).toBeNull()
    expect(chainIdFromCip34('eip155:1')).toBeNull()
  })
})

describe('normalizeCardanoChainId', () => {
  it('accepts both spellings on ingress and yields the canonical one', () => {
    expect(normalizeCardanoChainId('cardano:preprod')).toBe('cardano:preprod')
    expect(normalizeCardanoChainId('cip34:0-1')).toBe('cardano:preprod')
    expect(normalizeCardanoChainId('  cip34:1-764824073  ')).toBe('cardano:mainnet')
  })

  it('returns null rather than guessing, so callers reject instead of mislabelling', () => {
    expect(normalizeCardanoChainId('cardano:testnet')).toBeNull()
    expect(normalizeCardanoChainId('midnight:mainnet')).toBeNull()
    expect(normalizeCardanoChainId('nonsense')).toBeNull()
  })
})

describe('isCardanoChainId', () => {
  it('is true only for the canonical Cardano ids', () => {
    expect(isCardanoChainId('cardano:mainnet')).toBe(true)
    expect(isCardanoChainId('cardano:preprod')).toBe(true)
    expect(isCardanoChainId('cardano:preview')).toBe(true)
    expect(isCardanoChainId('cip34:1-764824073')).toBe(false)
    expect(isCardanoChainId('eip155:1')).toBe(false)
  })
})
