// Pinned vectors for `contract/identity.compact`'s derivation.
//
// `C` exists in three languages — the circuit, this module, and `preimage.rs`'s
// `identity_commitment` — and all three must agree byte-for-byte or a natively-built
// `publishRow` proof addresses a contract nobody can write. `circle.compact`'s derivations are
// pinned separately in `circle-derivations.test.ts`.
//
// The spike's vectors (`memberLeaf`, `openJoinNullifier`, `gateCommitment`, a three-element
// `actionNullifier`) were deleted with `pnyx.compact` — every one of them has a replacement of a
// different shape, so keeping them would have pinned the wrong contract.
import {describe, expect, it} from 'vitest'

import {bytes32} from './bytes.js'
import {
  customUnshieldedTokenType,
  handleDeployNonce,
  identityCommitment,
  identityDeployNonce,
  pad32,
  permitTokenType,
} from './derivations.js'
import {encodeHandle} from './handle.js'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

describe('pad32', () => {
  it('right-pads a label with zeros to 32 bytes', () => {
    expect(hex(pad32('pnyx:id'))).toBe(`${Buffer.from('pnyx:id').toString('hex')}${'00'.repeat(25)}`)
    expect(pad32('').length).toBe(32)
    expect(pad32('x'.repeat(32)).length).toBe(32)
  })

  it('refuses a label that would be truncated', () => {
    // Silently truncating would collide two distinct domains.
    expect(() => pad32('x'.repeat(33))).toThrow(/longer than 32 bytes/)
  })
})

describe('customUnshieldedTokenType', () => {
  // Duplicated in `rust/tests/token_type.rs` `token_type_matches_the_ledger`, which asserts the same
  // vector against the ledger's own `custom_unshielded_token_type`. Change both — a JS reproduction of
  // a chain derivation is only safe while something pins it to the chain.
  it('matches the ledger vector', () => {
    expect(hex(customUnshieldedTokenType(new Uint8Array(32).fill(0x2a), new Uint8Array(32).fill(0x07)))).toBe(
      '06908833ec6270c73c5a3e39d18866c556dff2f4f0eeff88b1884a2075915d84',
    )
  })

  it('separates on both inputs', () => {
    const addr = new Uint8Array(32).fill(0x2a)
    const domain = new Uint8Array(32).fill(0x07)
    expect(hex(customUnshieldedTokenType(addr, domain))).not.toBe(
      hex(customUnshieldedTokenType(new Uint8Array(32).fill(0x2b), domain)),
    )
    expect(hex(customUnshieldedTokenType(addr, domain))).not.toBe(
      hex(customUnshieldedTokenType(addr, new Uint8Array(32).fill(0x08))),
    )
  })

  it('rejects anything that is not 32 bytes', () => {
    expect(() => customUnshieldedTokenType(new Uint8Array(31), new Uint8Array(32))).toThrow(/32 bytes/)
    expect(() => customUnshieldedTokenType(new Uint8Array(32), new Uint8Array(31))).toThrow(/32 bytes/)
  })

  // Exact tier, never tier-or-better: `bind` accepts only the name's own tier, so a wallet holding a
  // t0 permit must not read as able to claim a t3 name.
  it('gives every tier its own permit colour', () => {
    const payment = new Uint8Array(32).fill(0x11)
    const colours = [0, 1, 2, 3, 4, 5, 6].map((t) => hex(permitTokenType(payment, t)))
    expect(new Set(colours).size).toBe(7)
  })
})

describe('identityCommitment', () => {
  // The same secret `preimage.rs`'s tests use (0x07 × 32), so the two languages are comparable by
  // eye. Pinned on the Rust side by `identity_commitment_matches_pinned_vector`; change both.
  it('matches the pinned vector', () => {
    expect(hex(identityCommitment(new Uint8Array(32).fill(0x07)))).toBe(
      '0aae573460035f37e38d60674d20f8be84c6519bca7e19ac2da68798afa92a12',
    )
  })

  it('separates on the secret', () => {
    expect(hex(identityCommitment(new Uint8Array(32).fill(1)))).not.toBe(
      hex(identityCommitment(new Uint8Array(32).fill(2))),
    )
  })
})

describe('deploy nonces — the cross-language contract with the native rail', () => {
  // The same two vectors are pinned in `rust/tests/build_pnyx_deploys.rs`. Duplicated on purpose:
  // changing one language's nonce without the other fails a test on that side, where sharing a helper
  // would let both drift together and move every contract address silently.
  it('handle', () => {
    expect(Buffer.from(handleDeployNonce(encodeHandle('zephyr'))).toString('hex')).toBe(
      '34dbb09a56da9f266af122e4c38889af8ff82cb48f03c67019988e3d3e3fef7b',
    )
  })

  it('identity', () => {
    expect(Buffer.from(identityDeployNonce(identityCommitment(bytes32(0x2a)))).toString('hex')).toBe(
      'ea92bfce3a30c3dfbb46d628b4a4612a4c4220633f08a616eda602e44da9b4dc',
    )
  })
})
