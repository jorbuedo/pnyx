import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {deriveEvmAddress, deriveEvmAddressFromMnemonic} from './evm.js'

// Canonical BIP-39 test mnemonic; its m/44'/60'/0'/0/0 address is widely published.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('deriveEvmAddress', () => {
  it('derives the canonical EIP-55 address for the test mnemonic', async () => {
    const addr = await Effect.runPromise(deriveEvmAddressFromMnemonic(MNEMONIC))
    expect(addr).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
  })

  it('derives distinct addresses per index', async () => {
    const seed = await import('../seed.js').then((m) => m.mnemonicToSeed(MNEMONIC))
    const a0 = await Effect.runPromise(deriveEvmAddress(seed, {index: 0}))
    const a1 = await Effect.runPromise(deriveEvmAddress(seed, {index: 1}))
    expect(a0).not.toBe(a1)
    expect(a0).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})
