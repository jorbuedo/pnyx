import {base58} from '@pnyx/crypto'
import {Effect, Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {mnemonicToSeed} from '../seed.js'
import {deriveSolanaAddress, deriveSolanaAddressFromMnemonic} from './solana.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('deriveSolanaAddress', () => {
  it('derives a valid, deterministic base58 address (32-byte ed25519 key)', async () => {
    // The SLIP-0010 ed25519 algorithm is validated authoritatively in
    // @pnyx/crypto hd.test.ts; here we assert the wallet-level shape + determinism.
    const a = await Effect.runPromise(deriveSolanaAddressFromMnemonic(MNEMONIC))
    const b = await Effect.runPromise(deriveSolanaAddressFromMnemonic(MNEMONIC))
    expect(a).toBe(b)
    const decoded = base58.decode(a)
    expect(Either.isRight(decoded)).toBe(true)
    if (Either.isRight(decoded)) expect(decoded.right.length).toBe(32)
  })

  it('derives distinct addresses per account', async () => {
    const seed = await mnemonicToSeed(MNEMONIC)
    const a0 = await Effect.runPromise(deriveSolanaAddress(seed, {account: 0}))
    const a1 = await Effect.runPromise(deriveSolanaAddress(seed, {account: 1}))
    expect(a0).not.toBe(a1)
  })
})
