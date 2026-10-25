/**
 * The pure-JS half of the shim, pinned against the **real WASM runtime** running in Node.
 *
 * ⚠️ This is the only layer where both implementations can run side by side: the device half needs
 * the native module and the WASM half needs an engine that has WebAssembly. So it is the one place a
 * direct byte comparison is possible, and it is where the encoding claims get to be facts rather
 * than measurements someone wrote down once.
 */

import * as ocrt from '@midnight-ntwrk/onchain-runtime-v3'
import {describe, expect, it} from 'vitest'
import {addField, bigIntToValue, MAX_FIELD, mulField, subField, valueToBigInt} from './field'

const CASES = [0n, 1n, 255n, 256n, 0x1234n, 2n ** 64n, 2n ** 200n + 7n, MAX_FIELD, MAX_FIELD - 1n]

describe('field encoding matches the WASM runtime byte for byte', () => {
  it.each(CASES)('bigIntToValue(%s)', (x) => {
    const ours = bigIntToValue(x)
    const theirs = ocrt.bigIntToValue(x)
    expect(ours.length).toBe(theirs.length)
    expect([...(ours[0] ?? [])]).toEqual([...(theirs[0] ?? [])])
  })

  it.each(CASES)('valueToBigInt round-trips %s the way the runtime does', (x) => {
    expect(valueToBigInt(ocrt.bigIntToValue(x))).toBe(x)
    expect(ocrt.valueToBigInt(bigIntToValue(x))).toBe(x)
  })

  // ⚠️ The trailing-zero rule is the whole encoding, and zero is where it bites: an empty atom, not
  // eight zero bytes. Getting this wrong is a transcript mismatch several layers away.
  it('encodes zero as an empty atom', () => {
    expect(bigIntToValue(0n)[0]?.length).toBe(0)
    expect(ocrt.bigIntToValue(0n)[0]?.length).toBe(0)
  })

  it('agrees with the runtime on the field modulus', () => {
    expect(MAX_FIELD).toBe(ocrt.maxField())
  })
})

describe('field arithmetic', () => {
  it('wraps at the modulus rather than growing', () => {
    expect(addField(MAX_FIELD, 1n)).toBe(0n)
    expect(subField(0n, 1n)).toBe(MAX_FIELD)
    expect(mulField(MAX_FIELD, 2n)).toBe(MAX_FIELD - 1n)
  })
})
