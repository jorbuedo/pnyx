import {
  encodeSegwitAddress,
  hash160,
  keccak256,
  secp256k1AccountXpub,
  secp256k1PrivateKeyAtPath,
  secp256k1PublicChild,
  secp256k1PublicKeyCompressed,
  secp256k1Raw64FromCompressed,
} from '@pnyx/crypto'
import {describe, expect, it} from 'vitest'
import {mnemonicToSeed} from '../seed.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

// Golden vectors (see bitcoin.test.ts / evm.test.ts) for the canonical mnemonic.
const BTC_MAINNET_0_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const EVM_0_0_CHECKSUMMED = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'

describe('secp256k1 seedless public-child (CKDpub)', () => {
  it('BTC: account xpub → public child m/84h/0h/0h/0/0 == private path, and rebuilds the golden bc1 address', async () => {
    const seed = await mnemonicToSeed(MNEMONIC)
    const xpub = secp256k1AccountXpub(seed, "m/84'/0'/0'")

    const publicChild = secp256k1PublicChild(xpub, 0, 0)
    const privateChild = secp256k1PublicKeyCompressed(secp256k1PrivateKeyAtPath(seed, "m/84'/0'/0'/0/0"))
    expect(hex(publicChild)).toBe(hex(privateChild))

    const addr = encodeSegwitAddress('bc', 0, hash160(publicChild))
    expect(addr).toBe(BTC_MAINNET_0_0)
  })

  it('EVM: account xpub → public child m/44h/60h/0h/0/0 == private path, and rebuilds the golden address bytes', async () => {
    const seed = await mnemonicToSeed(MNEMONIC)
    const xpub = secp256k1AccountXpub(seed, "m/44'/60'/0'")

    const publicChild = secp256k1PublicChild(xpub, 0, 0)
    const privateChild = secp256k1PublicKeyCompressed(secp256k1PrivateKeyAtPath(seed, "m/44'/60'/0'/0/0"))
    expect(hex(publicChild)).toBe(hex(privateChild))

    const addr20 = keccak256(secp256k1Raw64FromCompressed(publicChild)).slice(-20)
    expect(`0x${hex(addr20)}`).toBe(EVM_0_0_CHECKSUMMED.toLowerCase())
  })

  it('derives distinct receive/change children from one xpub', async () => {
    const seed = await mnemonicToSeed(MNEMONIC)
    const xpub = secp256k1AccountXpub(seed, "m/84'/0'/0'")
    const receive0 = secp256k1PublicChild(xpub, 0, 0)
    const change0 = secp256k1PublicChild(xpub, 1, 0)
    const receive1 = secp256k1PublicChild(xpub, 0, 1)
    expect(hex(receive0)).not.toBe(hex(change0))
    expect(hex(receive0)).not.toBe(hex(receive1))
  })

  it('throws when asked for a hardened index (impossible without the seed)', async () => {
    const seed = await mnemonicToSeed(MNEMONIC)
    const xpub = secp256k1AccountXpub(seed, "m/84'/0'/0'")
    expect(() => secp256k1PublicChild(xpub, 0x80000000, 0)).toThrow()
    expect(() => secp256k1PublicChild(xpub, 0, 0x80000000)).toThrow()
  })
})
