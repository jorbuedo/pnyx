import {describe, expect, it} from 'vitest'
import {rewardAddressFor} from './reward-address'

const STAKE_HASH = '337b8ee1e2ba0b5a0b0e9a3b1c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f'

describe('rewardAddressFor', () => {
  it('derives a mainnet reward address from a key stake credential', () => {
    const reward = rewardAddressFor(1, {hashHex: STAKE_HASH, type: 'key'})
    expect(reward?.startsWith('stake1')).toBe(true)
  })

  it('derives a testnet reward address under the testnet prefix', () => {
    const reward = rewardAddressFor(0, {hashHex: STAKE_HASH, type: 'key'})
    expect(reward?.startsWith('stake_test1')).toBe(true)
  })

  it('distinguishes a script stake credential from a key one', () => {
    const key = rewardAddressFor(1, {hashHex: STAKE_HASH, type: 'key'})
    const script = rewardAddressFor(1, {hashHex: STAKE_HASH, type: 'script'})
    expect(script).not.toBe(key)
    expect(script?.startsWith('stake1')).toBe(true)
  })

  it('returns undefined rather than guessing on an unknown network or bad hash', () => {
    expect(rewardAddressFor(7, {hashHex: STAKE_HASH, type: 'key'})).toBeUndefined()
    expect(rewardAddressFor(1, {hashHex: 'not-hex', type: 'key'})).toBeUndefined()
  })
})
