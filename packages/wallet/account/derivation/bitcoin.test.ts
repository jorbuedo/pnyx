import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {mnemonicToSeed} from '../seed.js'
import {deriveBitcoinAddress, deriveBitcoinAddressFromMnemonic} from './bitcoin.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('deriveBitcoinAddress', () => {
  it('derives the BIP-84 spec address for the test mnemonic (m/84h/0h/0h/0/0)', async () => {
    // From the BIP-84 specification's own test vector.
    const addr = await Effect.runPromise(deriveBitcoinAddressFromMnemonic(MNEMONIC))
    expect(addr).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')
  })

  it('derives a tb1 address on testnet', async () => {
    const seed = await mnemonicToSeed(MNEMONIC)
    const addr = await Effect.runPromise(deriveBitcoinAddress(seed, {network: 'preprod'}))
    expect(addr.startsWith('tb1q')).toBe(true)
  })
})
