import {describe, expect, it} from 'vitest'
import {dedupeWitnesses, missingKeyHashes, parsePath} from './witness.js'

const HARDENED = 0x80000000

describe('dedupeWitnesses', () => {
  it('drops later duplicates of the same vkey, preserving order', () => {
    const witnesses = [
      {vkeyHex: 'aa', sigHex: '01'},
      {vkeyHex: 'bb', sigHex: '02'},
      {vkeyHex: 'aa', sigHex: '03'},
    ]
    expect(dedupeWitnesses(witnesses)).toEqual([
      {vkeyHex: 'aa', sigHex: '01'},
      {vkeyHex: 'bb', sigHex: '02'},
    ])
  })

  it('passes distinct witnesses through unchanged', () => {
    const witnesses = [
      {vkeyHex: 'aa', sigHex: '01'},
      {vkeyHex: 'bb', sigHex: '02'},
    ]
    expect(dedupeWitnesses(witnesses)).toEqual(witnesses)
  })
})

describe('missingKeyHashes', () => {
  it('returns required hashes not covered by the witnesses', () => {
    expect(missingKeyHashes(['aa', 'bb'], ['aa', 'cc'])).toEqual(['cc'])
  })

  it('is case-insensitive', () => {
    expect(missingKeyHashes(['AA'], ['aa'])).toEqual([])
    expect(missingKeyHashes(['aa'], ['AA'])).toEqual([])
  })

  it('deduplicates the missing list', () => {
    expect(missingKeyHashes([], ['cc', 'CC'])).toEqual(['cc'])
  })

  it('returns empty when everything is covered', () => {
    expect(missingKeyHashes(['aa', 'bb'], ['bb'])).toEqual([])
  })
})

describe('parsePath', () => {
  it('parses a CIP-1852 payment path', () => {
    expect(parsePath("m/1852'/1815'/0'/0/0")).toEqual([
      (1852 | HARDENED) >>> 0,
      (1815 | HARDENED) >>> 0,
      HARDENED,
      0,
      0,
    ])
  })

  it('accepts h as the hardened marker and a missing m/ prefix', () => {
    expect(parsePath("1852h/1815h/2'/1/5")).toEqual([
      (1852 | HARDENED) >>> 0,
      (1815 | HARDENED) >>> 0,
      (2 | HARDENED) >>> 0,
      1,
      5,
    ])
  })

  it('throws on malformed components', () => {
    expect(() => parsePath('m/abc/0')).toThrow(/malformed/)
    expect(() => parsePath('m/')).toThrow()
    expect(() => parsePath('')).toThrow(/empty/)
  })

  it('throws on out-of-range indices', () => {
    expect(() => parsePath(`m/${HARDENED}/0`)).toThrow(/out of range/)
  })
})
