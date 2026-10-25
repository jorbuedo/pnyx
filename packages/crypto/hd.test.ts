import {describe, expect, it} from 'vitest'
import {ed25519PublicKey, secp256k1PublicKeyCompressed} from './curves.js'
import {ed25519PrivateKeyAtPath, secp256k1PrivateKeyAtPath} from './hd.js'

const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// SLIP-0010 ed25519 official test vector 1 (seed 000102...0f).
// https://github.com/satoshilabs/slips/blob/master/slip-0010.md
describe('ed25519PrivateKeyAtPath (SLIP-0010 test vector 1)', () => {
  const seed = fromHex('000102030405060708090a0b0c0d0e0f')

  it("m/0' matches the spec private + public key", () => {
    const priv = ed25519PrivateKeyAtPath(seed, "m/0'")
    expect(toHex(priv)).toBe('68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3')
    // Spec public key is prefixed with 0x00 (ed25519 marker); our pubkey is the 32-byte key.
    expect(toHex(ed25519PublicKey(priv))).toBe('8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c')
  })

  it("m/0'/1'/2'/2'/1000000000' matches the spec leaf", () => {
    const priv = ed25519PrivateKeyAtPath(seed, "m/0'/1'/2'/2'/1000000000'")
    expect(toHex(priv)).toBe('8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793')
    expect(toHex(ed25519PublicKey(priv))).toBe('3c24da049451555d51a7014a37337aa4e12d41e485abccfa46b47dfb2af54b7a')
  })

  it('rejects a non-hardened segment', () => {
    expect(() => ed25519PrivateKeyAtPath(seed, "m/0'/1")).toThrow(/hardened/)
  })
})

// BIP-32 official test vector 1 (seed 000102...0f) — validates secp256k1 HD.
// https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
describe('secp256k1PrivateKeyAtPath (BIP-32 test vector 1)', () => {
  const seed = fromHex('000102030405060708090a0b0c0d0e0f')

  it("m/0'/1 matches the spec private + public key", () => {
    // Chain m/0'/1 → known private key 3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368.
    const priv = secp256k1PrivateKeyAtPath(seed, "m/0'/1")
    expect(toHex(priv)).toBe('3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368')
    expect(toHex(secp256k1PublicKeyCompressed(priv))).toBe(
      '03501e454bf00751f24b1b489aa925215d66af2234e3891c3b21a52bedb3cd711c',
    )
  })
})
