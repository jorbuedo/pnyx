import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {describe, expect, it} from 'vitest'
import {decodeUr, encodeMultiPartUr, encodeSinglePartUr, isMultiPart, isUrFrame} from './ur.js'
import {xoshiro256FromString} from './xoshiro256.js'

/** The reference's `make_message_ur`: `len` "Wolf" bytes, wrapped as a CBOR byte string. */
const makeMessageUr = (length: number, seed = 'Wolf'): Uint8Array =>
  Cbor.Serializer.newVec().writeBytes(xoshiro256FromString(seed).nextData(length)).finalize()

/** From the reference's single-part UR test, `make_message_ur(50)`. */
const SINGLE_PART_50 =
  'ur:bytes/hdeymejtswhhylkepmykhhtsytsnoyoyaxaedsuttydmmhhpktpmsrjtgwdpfnsboxgwlbaawzuefywkdplrsrjynbvygabwjldapfcsdwkbrkch'

describe('single-part UR', () => {
  it('reproduces the reference vector', () => {
    expect(encodeSinglePartUr({type: 'bytes', cbor: makeMessageUr(50)})).toBe(SINGLE_PART_50)
  })

  it('round-trips the reference vector back to the same CBOR', () => {
    const decoded = decodeUr(SINGLE_PART_50)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value.type).toBe('bytes')
    expect(isMultiPart(decoded.value)).toBe(false)
    expect(Array.from(decoded.value.cbor)).toEqual(Array.from(makeMessageUr(50)))
  })

  // QR alphanumeric mode has no lowercase, so devices emit the uppercase form to keep the code
  // small. Rejecting it would fail against most real hardware.
  it('accepts the uppercase form devices actually emit', () => {
    const decoded = decodeUr(SINGLE_PART_50.toUpperCase())
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(Array.from(decoded.value.cbor)).toEqual(Array.from(makeMessageUr(50)))
  })

  it('tolerates surrounding whitespace', () => {
    expect(decodeUr(`  ${SINGLE_PART_50}\n`).ok).toBe(true)
  })
})

describe('multi-part UR', () => {
  const part = {type: 'bytes', cbor: Uint8Array.from([1, 2, 3, 4]), seqNum: 12, seqLen: 9}

  it('round-trips', () => {
    const encoded = encodeMultiPartUr(part)
    expect(encoded.startsWith('ur:bytes/12-9/')).toBe(true)
    const decoded = decodeUr(encoded)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(isMultiPart(decoded.value)).toBe(true)
    if (!isMultiPart(decoded.value)) return
    expect(decoded.value.seqNum).toBe(12)
    expect(decoded.value.seqLen).toBe(9)
    expect(Array.from(decoded.value.cbor)).toEqual([1, 2, 3, 4])
  })

  // seqNum > seqLen is not an error — that is exactly what a fountain mix looks like.
  it('accepts a sequence number past the sequence length', () => {
    const decoded = decodeUr(encodeMultiPartUr({...part, seqNum: 400, seqLen: 9}))
    expect(decoded.ok).toBe(true)
  })
})

describe('rejects malformed input rather than guessing', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['no scheme', 'bytes/hdey', 'not-a-ur'],
    ['a bare word', 'hello', 'not-a-ur'],
    ['too many segments', 'ur:bytes/1-2/3-4/hdey', 'not-a-ur'],
    ['an empty type', 'ur://hdey', 'invalid-type'],
    ['an uppercase-only type after normalisation is fine, but symbols are not', 'ur:by$tes/hdey', 'invalid-type'],
    ['a non-numeric sequence', 'ur:bytes/a-b/hdey', 'invalid-sequence'],
    ['a zero sequence number', 'ur:bytes/0-9/hdey', 'invalid-sequence'],
    ['bytewords that are not words', 'ur:bytes/zzzz', 'invalid-payload'],
  ]

  for (const [name, input, expectedKind] of cases) {
    it(`rejects ${name}`, () => {
      const decoded = decodeUr(input)
      expect(decoded.ok).toBe(false)
      if (!decoded.ok) expect(decoded.error.kind).toBe(expectedKind)
    })
  }

  it('rejects a payload whose checksum does not match', () => {
    const encoded = encodeSinglePartUr({type: 'bytes', cbor: Uint8Array.from([1, 2, 3, 4])})
    // Swap the first word for a different byte; the trailer still describes the original.
    const corrupted = encoded.replace('/', '/zo')
    const decoded = decodeUr(corrupted)
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error.kind).toBe('invalid-payload')
  })

  it('refuses to encode an invalid type', () => {
    expect(() => encodeSinglePartUr({type: 'Bytes', cbor: new Uint8Array()})).toThrow(/invalid type/)
  })
})

describe('isUrFrame', () => {
  it('recognises a frame by its scheme, in either case and with whitespace', () => {
    expect(isUrFrame(SINGLE_PART_50)).toBe(true)
    expect(isUrFrame(SINGLE_PART_50.toUpperCase())).toBe(true)
    expect(isUrFrame(`  ${SINGLE_PART_50}\n`)).toBe(true)
  })

  // A general scanner routes on this before it can know whether the payload is sound. A mis-read
  // frame of a genuine sequence must reach the accumulator, not fall through to address parsing.
  it('accepts a malformed frame, which decodeUr is what rejects', () => {
    expect(isUrFrame('ur:bytes/not-bytewords')).toBe(true)
    expect(decodeUr('ur:bytes/not-bytewords').ok).toBe(false)
  })

  it('rejects the other things a camera reads', () => {
    for (const other of [
      'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7s',
      'web+cardano://addr1abc',
      'pnyx://dm/new',
      'https://pnyx.example/x',
      '',
      'urgent',
    ]) {
      expect(isUrFrame(other)).toBe(false)
    }
  })
})
