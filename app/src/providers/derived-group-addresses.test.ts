import {ETHEREUM_MAINNET, SOLANA_MAINNET} from '@pnyx/config'
import {describe, expect, it} from 'vitest'
import {type DerivedGroupAddresses, mergeChainAddress} from './derived-group-addresses'

const empty = (groupId: string | null = null): DerivedGroupAddresses => ({
  groupId,
  addresses: new Map(),
})

describe('mergeChainAddress', () => {
  it('adds a new chain address for the matching group', () => {
    const next = mergeChainAddress(empty('g1'), 'g1', ETHEREUM_MAINNET, '0xabc')
    expect(next.groupId).toBe('g1')
    expect(next.addresses.get(ETHEREUM_MAINNET)).toBe('0xabc')
  })

  it('preserves previously derived chain addresses (mid-session chain-enable case)', () => {
    const prev: DerivedGroupAddresses = {
      groupId: 'g1',
      addresses: new Map([[SOLANA_MAINNET, 'SoLAddr']]),
    }
    const next = mergeChainAddress(prev, 'g1', ETHEREUM_MAINNET, '0xabc')
    expect(next.addresses.get(SOLANA_MAINNET)).toBe('SoLAddr')
    expect(next.addresses.get(ETHEREUM_MAINNET)).toBe('0xabc')
  })

  it('returns the previous state unchanged when the active group has switched', () => {
    const prev: DerivedGroupAddresses = {
      groupId: 'g2',
      addresses: new Map([[SOLANA_MAINNET, 'SoLAddr']]),
    }
    const next = mergeChainAddress(prev, 'g1', ETHEREUM_MAINNET, '0xabc')
    expect(next).toBe(prev)
  })

  it('returns the previous state unchanged when no group is active', () => {
    const prev = empty(null)
    const next = mergeChainAddress(prev, 'g1', ETHEREUM_MAINNET, '0xabc')
    expect(next).toBe(prev)
  })

  it('does not mutate the previous Map', () => {
    const prev: DerivedGroupAddresses = {
      groupId: 'g1',
      addresses: new Map([[SOLANA_MAINNET, 'SoLAddr']]),
    }
    const beforeSize = prev.addresses.size
    mergeChainAddress(prev, 'g1', ETHEREUM_MAINNET, '0xabc')
    expect(prev.addresses.size).toBe(beforeSize)
    expect(prev.addresses.has(ETHEREUM_MAINNET)).toBe(false)
  })
})
