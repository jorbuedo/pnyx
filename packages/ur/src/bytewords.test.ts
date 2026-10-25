import {describe, expect, it} from 'vitest'
import {
  BYTEWORDS,
  bytewordsFromBytes,
  bytewordsToBytes,
  decodeBytewords,
  encodeBytewords,
  minimalKey,
} from './bytewords.js'
import {crc32} from './crc32.js'

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/.{2}/g) ?? []).map((byte) => Number.parseInt(byte, 16)))

/**
 * The worked example from BCR-2020-012. Its 31 bytes already carry the 4-byte CRC-32 trailer,
 * so it pins the word table, all three styles, *and* the checksum rule in one vector.
 */
const VECTOR_WITH_TRAILER = 'd99d6ca20150c7098580125e2ab0981253468b2dbc5202c11947dac904f40b'
const VECTOR_BODY = VECTOR_WITH_TRAILER.slice(0, -8)

const STANDARD =
  'tuna next jazz oboe acid good slot axis limp lava brag holy door puff monk brag ' +
  'guru frog luau drop roof grim also safe chef fuel twin solo aqua work bald'
const MINIMAL = 'tantjzoeadgdstaslplabghydrpfmkbggufgludprfgmaosecffltnsoaawkbd'

describe('the word table', () => {
  it('holds 256 unique four-letter words', () => {
    expect(BYTEWORDS).toHaveLength(256)
    expect(new Set(BYTEWORDS).size).toBe(256)
    expect(BYTEWORDS.every((word) => /^[a-z]{4}$/.test(word))).toBe(true)
  })

  // The property the minimal style depends on. Without it, two bytes would share an encoding.
  it('gives every word a unique first+last letter pair', () => {
    expect(new Set(BYTEWORDS.map(minimalKey)).size).toBe(256)
  })

  it('is the table the spec specifies at the boundaries', () => {
    expect(BYTEWORDS[0]).toBe('able')
    expect(BYTEWORDS[255]).toBe('zoom')
    expect(BYTEWORDS[0xd9]).toBe('tuna')
    expect(BYTEWORDS[0x0b]).toBe('bald')
  })
})

describe('the BCR-2020-012 vector', () => {
  it('renders in every style', () => {
    const bytes = fromHex(VECTOR_WITH_TRAILER)
    expect(bytewordsFromBytes(bytes, 'standard')).toBe(STANDARD)
    expect(bytewordsFromBytes(bytes, 'uri')).toBe(STANDARD.split(' ').join('-'))
    expect(bytewordsFromBytes(bytes, 'minimal')).toBe(MINIMAL)
  })

  // The vector's trailer has to be exactly what our CRC-32 produces over its body, which ties
  // the checksum layer to the published bytes rather than to our own encoder.
  it('has a trailer our CRC-32 reproduces', () => {
    expect(crc32(fromHex(VECTOR_BODY))).toBe(0xc904f40b)
  })

  it('round-trips through the checksummed API', () => {
    const body = fromHex(VECTOR_BODY)
    expect(encodeBytewords(body, 'minimal')).toBe(MINIMAL)
    const decoded = decodeBytewords(MINIMAL, 'minimal')
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(Array.from(decoded.data)).toEqual(Array.from(body))
  })
})

describe('round-trips', () => {
  it('survives every byte value in every style', () => {
    const all = Uint8Array.from({length: 256}, (_, i) => i)
    for (const style of ['standard', 'uri', 'minimal'] as const) {
      const decoded = decodeBytewords(encodeBytewords(all, style), style)
      expect(decoded.ok).toBe(true)
      if (decoded.ok) expect(Array.from(decoded.data)).toEqual(Array.from(all))
    }
  })

  it('handles an empty payload', () => {
    const decoded = decodeBytewords(encodeBytewords(new Uint8Array(), 'minimal'), 'minimal')
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.data).toHaveLength(0)
  })
})

describe('rejects bad input rather than guessing', () => {
  it('rejects an unknown word', () => {
    const decoded = decodeBytewords('tuna next zzzz oboe', 'standard')
    expect(decoded).toEqual({ok: false, error: {kind: 'unknown-word', token: 'zzzz'}})
  })

  it('rejects an odd-length minimal string', () => {
    const decoded = bytewordsToBytes('tantj', 'minimal')
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error.kind).toBe('malformed')
  })

  it('rejects a corrupted body whose trailer no longer matches', () => {
    const encoded = encodeBytewords(Uint8Array.from([1, 2, 3, 4]), 'minimal')
    // Flip the first word to a different byte; the trailer still describes the original.
    const corrupted = `${bytewordsFromBytes(Uint8Array.from([0xff]), 'minimal')}${encoded.slice(2)}`
    const decoded = decodeBytewords(corrupted, 'minimal')
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error.kind).toBe('checksum-mismatch')
  })

  it('rejects input too short to hold a checksum', () => {
    const decoded = decodeBytewords(bytewordsFromBytes(Uint8Array.from([1, 2]), 'minimal'), 'minimal')
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error.kind).toBe('malformed')
  })

  // The boundary the guard sits on: 4 bytes is a valid empty payload, 3 is not.
  it('accepts exactly a bare checksum but not less', () => {
    expect(decodeBytewords(encodeBytewords(new Uint8Array(), 'minimal'), 'minimal').ok).toBe(true)
    expect(decodeBytewords(bytewordsFromBytes(Uint8Array.from([1, 2, 3]), 'minimal'), 'minimal').ok).toBe(false)
  })
})
