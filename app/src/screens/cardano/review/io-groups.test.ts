import type {ReviewedIO} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {groupIosByAddress} from './io-groups'

const io = (address: string, quantity: bigint, outpoint?: {txHashHex: string; index: number}): ReviewedIO => ({
  address: {hex: address, bech32: address},
  ownership: {level: 'none'},
  amounts: [{quantity}],
  ...(outpoint !== undefined ? {outpoint} : {}),
})

const HASH = 'aa'.repeat(32)

describe('groupIosByAddress', () => {
  it('collects every UTxO at an address under one group, in transaction order', () => {
    const groups = groupIosByAddress([
      io('addr_a', 1n, {txHashHex: HASH, index: 0}),
      io('addr_b', 2n, {txHashHex: HASH, index: 1}),
      io('addr_a', 3n, {txHashHex: HASH, index: 2}),
    ])

    expect(groups.map((g) => g.address.hex)).toEqual(['addr_a', 'addr_b'])
    expect(groups[0]?.entries.map((e) => e.outpoint?.index)).toEqual([0, 2])
    expect(groups[1]?.entries).toHaveLength(1)
  })

  it('keeps outpoint-less entries as separate UTxOs (unsigned outputs share no identity)', () => {
    const groups = groupIosByAddress([io('addr_a', 1n), io('addr_a', 2n)])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.entries.map((e) => e.amounts[0]?.quantity)).toEqual([1n, 2n])
    expect(groups[0]?.entries.every((e) => e.outpoint === undefined)).toBe(true)
  })

  it('returns nothing for no IOs', () => {
    expect(groupIosByAddress([])).toEqual([])
  })
})
