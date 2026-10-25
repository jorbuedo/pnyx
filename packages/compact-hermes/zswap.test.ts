/**
 * The zswap coin surface, pinned against the **real WASM runtime** running in Node.
 *
 * ⚠️ **Every claim here was measured, and the first guess was wrong.** These read as if they must be
 * bech32m — they are the coin public keys and contract addresses a wallet shows — and they are not:
 * at this layer each one is plain lowercase hex of exactly 32 bytes, and a coin's two spellings
 * differ only in that Compact calls the token `color` where the runtime calls it `type`.
 *
 * `runtimeCoinCommitment` is absent on purpose: it is the one leaf that reaches the native bridge,
 * so Node cannot run it. It is pinned on the Rust side instead, against these same vectors
 * (`rust/tests/compact_host_bridge.rs::a_coin_commitment_matches_the_wasm_runtime`).
 */

import * as ocrt from '@midnight-ntwrk/onchain-runtime-v3'
import {describe, expect, it} from 'vitest'
import {
  decodeCoinPublicKey,
  decodeContractAddress,
  decodeQualifiedShieldedCoinInfo,
  decodeShieldedCoinInfo,
  encodeCoinPublicKey,
  encodeContractAddress,
  encodeQualifiedShieldedCoinInfo,
  encodeShieldedCoinInfo,
} from './index'

const filled = (byte: number): Uint8Array => new Uint8Array(32).fill(byte)
const hex = (byte: number): string => byte.toString(16).padStart(2, '0').repeat(32)

describe('coin public keys and contract addresses are hex, not bech32m', () => {
  it.each([0x00, 0x01, 0xab, 0xff])('decodes 0x%s the way the runtime does', (byte) => {
    expect(decodeCoinPublicKey(filled(byte))).toBe(ocrt.decodeCoinPublicKey(filled(byte)))
    expect(decodeContractAddress(filled(byte))).toBe(ocrt.decodeContractAddress(filled(byte)))
  })

  it.each([0x00, 0x01, 0xab, 0xff])('encodes 0x%s the way the runtime does', (byte) => {
    expect([...encodeCoinPublicKey(hex(byte))]).toEqual([...ocrt.encodeCoinPublicKey(hex(byte))])
    expect([...encodeContractAddress(hex(byte))]).toEqual([...ocrt.encodeContractAddress(hex(byte))])
  })

  it('accepts uppercase hex, as the runtime does', () => {
    expect([...encodeCoinPublicKey('AB'.repeat(32))]).toEqual([...ocrt.encodeCoinPublicKey('AB'.repeat(32))])
  })

  // ⚠️ Refusing is the behaviour under test, not an edge case. Upstream throws on every one of
  // these; a shim that zero-extended instead would hand back a key addressing a coin nobody holds.
  it.each([
    ['too short', 'abcd'],
    ['odd length', 'abc'],
    ['empty', ''],
    ['not hex', 'ZZ'.repeat(32)],
    ['a tagged 35-byte address', '00'.repeat(35)],
  ])('refuses %s rather than padding it', (_label, bad) => {
    expect(() => ocrt.encodeCoinPublicKey(bad)).toThrow()
    expect(() => encodeCoinPublicKey(bad)).toThrow()
  })

  it.each([0, 16, 33])('refuses a %s-byte key rather than truncating it', (length) => {
    expect(() => ocrt.decodeCoinPublicKey(new Uint8Array(length))).toThrow()
    expect(() => decodeCoinPublicKey(new Uint8Array(length))).toThrow()
  })
})

describe('a coin is the same three fields under two names', () => {
  const compact = {color: filled(1), nonce: filled(2), value: 42n}

  it('decodes to the runtime spelling the runtime itself produces', () => {
    expect(decodeShieldedCoinInfo(compact)).toEqual(ocrt.decodeShieldedCoinInfo(compact))
  })

  it('re-encodes to the Compact spelling byte for byte', () => {
    const runtime = ocrt.decodeShieldedCoinInfo(compact)
    const ours = encodeShieldedCoinInfo(runtime)
    const theirs = ocrt.encodeShieldedCoinInfo(runtime)
    expect([...ours.color]).toEqual([...theirs.color])
    expect([...ours.nonce]).toEqual([...theirs.nonce])
    expect(ours.value).toBe(theirs.value)
  })

  it('carries the Merkle index through the qualified pair', () => {
    const qualified = {...compact, mt_index: 7n}
    expect(decodeQualifiedShieldedCoinInfo(qualified)).toEqual(ocrt.decodeQualifiedShieldedCoinInfo(qualified))
    const runtime = ocrt.decodeQualifiedShieldedCoinInfo(qualified)
    expect(encodeQualifiedShieldedCoinInfo(runtime).mt_index).toBe(
      ocrt.encodeQualifiedShieldedCoinInfo(runtime).mt_index,
    )
  })

  // A value is a u128 and an index is a u64 — different widths, and the runtime enforces both.
  it('refuses a value outside u128 and an index outside u64', () => {
    const runtime = {type: hex(1), nonce: hex(2), value: 1n}
    expect(() => encodeShieldedCoinInfo({...runtime, value: 2n ** 128n})).toThrow(/out of range/)
    expect(() => encodeShieldedCoinInfo({...runtime, value: -1n})).toThrow(/out of range/)
    expect(() => encodeQualifiedShieldedCoinInfo({...runtime, mt_index: 2n ** 64n})).toThrow(/out of range/)
    expect(() => ocrt.encodeShieldedCoinInfo({...runtime, value: 2n ** 128n})).toThrow()
    expect(() =>
      ocrt.decodeQualifiedShieldedCoinInfo({color: filled(1), nonce: filled(2), value: 1n, mt_index: 2n ** 64n}),
    ).toThrow()
  })
})
