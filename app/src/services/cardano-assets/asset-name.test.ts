import {describe, expect, it} from 'vitest'
import {cip68ClassOf, decodeAssetName, splitCip67Label} from './asset-name'

const hexOf = (text: string) => [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('splitCip67Label', () => {
  it.each([
    ['000643b0', 100, 'reference'],
    ['000de140', 222, 'nft'],
    ['0014df10', 333, 'ft'],
    ['001bc280', 444, 'rft'],
  ] as const)('recognises the standard label %s', (prefix, label, cls) => {
    const split = splitCip67Label(`${prefix}${hexOf('NAME')}`)
    expect(split).toEqual({label, restHex: hexOf('NAME')})
    expect(cip68ClassOf(label)).toBe(cls)
  })

  it('rejects a lookalike whose checksum does not match', () => {
    // Same shape (0…0) and a plausible label number, wrong CRC-8 — a real asset
    // name that merely starts with 00 must keep all of its bytes.
    expect(splitCip67Label('0012ab30deadbeef')).toBeNull()
  })

  it('rejects a name too short to hold a label', () => {
    expect(splitCip67Label('0014df')).toBeNull()
  })
})

describe('decodeAssetName', () => {
  it('reads the name behind a CIP-67 label', () => {
    // The token that showed as "0014df10" in the app.
    expect(decodeAssetName('0014df10434c4950204954')).toBe('CLIP IT')
  })

  it('reads a plain ASCII name', () => {
    expect(decodeAssetName(hexOf('HOSKY'))).toBe('HOSKY')
  })

  it('reads a non-ASCII UTF-8 name, which the printable-ASCII rule rejected', () => {
    expect(decodeAssetName(hexOf('Café'))).toBe('Café')
    expect(decodeAssetName(hexOf('日本'))).toBe('日本')
  })

  it('returns null — not hex — for bytes that are not text', () => {
    expect(decodeAssetName('ff00ff00')).toBeNull()
    expect(decodeAssetName('')).toBeNull()
  })

  it('returns null for a name that decodes but holds control characters', () => {
    expect(decodeAssetName('4142430001')).toBeNull()
  })

  it('returns null when a CIP-67 label has nothing after it', () => {
    // A CIP-68 reference token's name can be the bare label.
    expect(decodeAssetName('000643b0')).toBeNull()
  })

  it('ignores an odd-length or non-hex name rather than throwing', () => {
    expect(decodeAssetName('abc')).toBeNull()
    expect(decodeAssetName('zzzz')).toBeNull()
  })
})
