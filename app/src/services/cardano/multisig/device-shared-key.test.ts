import {describe, expect, it} from 'vitest'
import {cardanoAccountPath, cardanoSharedAccountPath} from '../account'
import {sameXpubHex, xpubHexOf} from './device-shared-key'

describe('cardanoSharedAccountPath', () => {
  it('is the CIP-1854 chain, not CIP-1852', () => {
    // A different purpose index means a completely different key at the same
    // account. Handing a 1852 key to a roster names the wrong wallet.
    expect(cardanoSharedAccountPath(0)).toBe("m/1854'/1815'/0'")
    expect(cardanoSharedAccountPath(3)).toBe("m/1854'/1815'/3'")
    expect(cardanoSharedAccountPath(0)).not.toBe(cardanoAccountPath(0))
  })
})

describe('xpubHexOf', () => {
  it('is the public key followed by the chain code, 128 hex', () => {
    const pub = new Uint8Array(32).fill(0xab)
    const chainCode = new Uint8Array(32).fill(0x01)
    const hex = xpubHexOf(pub, chainCode)
    expect(hex).toHaveLength(128)
    expect(hex.slice(0, 64)).toBe('ab'.repeat(32))
    expect(hex.slice(64)).toBe('01'.repeat(32))
  })

  it('pads a byte below 0x10 to two digits', () => {
    // A single-digit byte would shift every byte after it, so the whole key
    // compares unequal against the same key spelled by the seed path.
    expect(xpubHexOf(new Uint8Array([0x00, 0x0f]), new Uint8Array([0x09]))).toBe('000f09')
  })
})

describe('sameXpubHex', () => {
  it('ignores case, because the three producers of this string disagree on it', () => {
    expect(sameXpubHex('ABCD', 'abcd')).toBe(true)
  })

  it('is false for different keys', () => {
    expect(sameXpubHex('abcd', 'abce')).toBe(false)
  })
})
