// The owner key a co-funded offer is built from. If this disagrees with the Rust by one byte, every
// input is attributed to a wallet that cannot sign it — and the failure arrives as "a contributor's
// signature does not verify", naming nothing about why.
import {describe, expect, it} from 'vitest'
import {nightVerifyingKey} from './owner-key'

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('nightVerifyingKey', () => {
  it('matches what the Rust serializes for the same key', () => {
    // ⚠️ Vector taken from `midnight_base_crypto`'s own `SigningKey::verifying_key()`, run in
    // `packages/midnight-native/rust` against this exact key. Regenerate the same way if it ever
    // needs changing — do not adjust it to match whatever this function starts returning.
    const key = new Uint8Array(32).fill(7)
    expect(hex(nightVerifyingKey(key))).toBe('989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f')
  })

  it('is 32 bytes — x-only, as the ledger serializes it', () => {
    expect(nightVerifyingKey(new Uint8Array(32).fill(1))).toHaveLength(32)
  })

  it('gives different wallets different owners', () => {
    const a = hex(nightVerifyingKey(new Uint8Array(32).fill(1)))
    const b = hex(nightVerifyingKey(new Uint8Array(32).fill(2)))
    expect(a).not.toBe(b)
  })

  it('refuses a key that is not 32 bytes rather than deriving from a truncated one', () => {
    expect(() => nightVerifyingKey(new Uint8Array(16))).toThrow(/32 bytes/)
  })
})
