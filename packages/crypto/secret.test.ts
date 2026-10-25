import {describe, expect, it} from 'vitest'
import {asMnemonic, asSecretBytes, wipeSecret} from './secret.js'

describe('secret brands', () => {
  it('asMnemonic is identity at runtime', () => {
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    expect(asMnemonic(phrase)).toBe(phrase)
  })

  it('asSecretBytes preserves the same buffer rather than copying', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const branded = asSecretBytes(bytes)
    expect(branded).toBe(bytes)
    bytes[0] = 9
    expect(branded[0]).toBe(9)
  })

  it('wipeSecret zeroes every byte in place', () => {
    const branded = asSecretBytes(new Uint8Array([7, 7, 7, 7]))
    wipeSecret(branded)
    expect([...branded]).toEqual([0, 0, 0, 0])
  })

  // The documented limitation, asserted so nobody later claims erasure: a view
  // wipes only its own window of a shared ArrayBuffer.
  it('wipeSecret does not reach bytes outside its own view', () => {
    const buffer = new ArrayBuffer(4)
    new Uint8Array(buffer).fill(5)
    wipeSecret(asSecretBytes(new Uint8Array(buffer, 1, 2)))
    expect([...new Uint8Array(buffer)]).toEqual([5, 0, 0, 5])
  })
})
