import {describe, expect, it} from 'vitest'
import {isByronAddress} from './byron-address'

describe('isByronAddress', () => {
  it('recognises the mainnet forms', () => {
    // Real prefixes from a mainnet history walk.
    expect(isByronAddress('DdzFFzCqrhspxAGFgUa')).toBe(true)
    expect(isByronAddress('Ae2tdPwUPEZFRbyhz3ez1xy')).toBe(true)
  })

  it('recognises the testnet form', () => {
    expect(isByronAddress('2cWKMJemoBainCidK6K')).toBe(true)
  })

  it('tolerates surrounding whitespace, as a pasted address carries', () => {
    expect(isByronAddress('  DdzFFzCqrhsp  ')).toBe(true)
  })

  it('is false for a Shelley bech32 address', () => {
    expect(isByronAddress('addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw')).toBe(false)
    expect(isByronAddress('stake1u8pcjgmx7962w6hey5hhsd502araxp26kdtgagakhaqtq8squng76')).toBe(false)
  })

  it('is false for prose and empty input, so a real failure still reads as one', () => {
    expect(isByronAddress('')).toBe(false)
    expect(isByronAddress('not an address')).toBe(false)
  })
})
