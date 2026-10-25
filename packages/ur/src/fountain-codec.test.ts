import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {describe, expect, it} from 'vitest'
import {crc32} from './crc32.js'
import {chooseFragments} from './fountain.js'
import {fountainDecoder} from './fountain-decoder.js'
import {fountainEncoder} from './fountain-encoder.js'
import {decodePart, encodePart} from './part.js'
import {decodeUr, isMultiPart} from './ur.js'
import {xoshiro256FromString} from './xoshiro256.js'

const makeMessage = (length: number, seed = 'Wolf'): Uint8Array => xoshiro256FromString(seed).nextData(length)

const hex = (data: Uint8Array): string => Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** Feed a UR string into a decoder, unwrapping the envelope first. */
const feed = (decoder: ReturnType<typeof fountainDecoder>, urString: string) => {
  const parsed = decodeUr(urString)
  if (!parsed.ok || !isMultiPart(parsed.value)) throw new Error(`not a multi-part UR: ${urString}`)
  return decoder.receivePart(parsed.value.cbor)
}

describe('the part payload', () => {
  it('round-trips through CBOR', () => {
    const part = {seqNum: 12, seqLen: 9, messageLen: 256, checksum: 23570951, data: makeMessage(29)}
    const decoded = decodePart(encodePart(part))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect({...decoded.part, data: hex(decoded.part.data)}).toEqual({...part, data: hex(part.data)})
  })

  // These numbers size the decoder's buffers and come from a scanned code, so they are checked
  // rather than trusted.
  it('rejects hostile or inconsistent headers', () => {
    const bad = (seqNum: number, seqLen: number, messageLen: number, dataLen: number): string => {
      const cbor = Cbor.Serializer.newVec()
        .writeArray(Cbor.len(5))
        .writeUnsignedInteger(seqNum)
        .writeUnsignedInteger(seqLen)
        .writeUnsignedInteger(messageLen)
        .writeUnsignedInteger(0)
        .writeBytes(new Uint8Array(dataLen))
        .finalize()
      const result = decodePart(cbor)
      return result.ok ? 'ACCEPTED' : result.error
    }
    expect(bad(0, 9, 256, 29)).toMatch(/seqNum/)
    expect(bad(1, 0, 256, 29)).toMatch(/seqLen/)
    expect(bad(1, 9_999_999, 256, 29)).toMatch(/seqLen/)
    expect(bad(1, 9, 0, 29)).toMatch(/messageLen/)
    expect(bad(1, 9, 999_999_999, 29)).toMatch(/messageLen/)
    // 2 fragments of 10 cannot hold a 256-byte message.
    expect(bad(1, 2, 256, 10)).toMatch(/cannot hold/)
    expect(bad(1, 9, 256, 0)).toMatch(/no data/)
  })

  it('rejects a non-array payload', () => {
    const notAnArray = Cbor.Serializer.newVec().writeUnsignedInteger(42).finalize()
    expect(decodePart(notAnArray).ok).toBe(false)
  })
})

describe('encoder', () => {
  it('uses the reference fragment length and count', () => {
    const encoder = fountainEncoder(makeMessage(256), 'bytes', 30)
    expect(encoder.seqLen).toBe(9)
    expect(encoder.checksum).toBe(23570951)
    expect(encoder.isSinglePart).toBe(false)
  })

  // Parts 1..seqLen are the fragments in order, so these must equal the published fragment bytes.
  it('emits the reference fragments as its first parts', () => {
    const encoder = fountainEncoder(makeMessage(256), 'bytes', 30)
    const first = [encoder.nextFountainPart(), encoder.nextFountainPart(), encoder.nextFountainPart()]
    expect(first.map((part) => hex(part.data))).toEqual([
      '916ec65cf77cadf55cd7f9cda1a1030026ddd42e905b77adc36e4f2d3c',
      'cba44f7f04f2de44f42d84c374a0e149136f25b01852545961d55f7f7a',
      '8cde6d0e2ec43f3b2dcb644a2209e8c9e34af5c4747984a5e873c9cf5f',
    ])
    expect(first.map((part) => part.seqNum)).toEqual([1, 2, 3])
  })

  // A message that fits one fragment gets the short form; the sequence header would be overhead.
  it('emits a single-part UR when the message fits', () => {
    const encoder = fountainEncoder(makeMessage(20), 'bytes', 100)
    expect(encoder.isSinglePart).toBe(true)
    expect(encoder.nextPart()).toMatch(/^ur:bytes\/[a-z]+$/)
  })

  it('produces well-formed multi-part URs', () => {
    const encoder = fountainEncoder(makeMessage(256), 'bytes', 30)
    expect(encoder.nextPart()).toMatch(/^ur:bytes\/1-9\/[a-z]+$/)
    expect(encoder.nextPart()).toMatch(/^ur:bytes\/2-9\/[a-z]+$/)
  })

  it('refuses an empty message', () => {
    expect(() => fountainEncoder(new Uint8Array(), 'bytes', 30)).toThrow(/empty/)
  })
})

describe('round trips', () => {
  it('decodes a clean stream in exactly seqLen parts', () => {
    const message = makeMessage(256)
    const encoder = fountainEncoder(message, 'bytes', 30)
    const decoder = fountainDecoder()

    let result = feed(decoder, encoder.nextPart())
    let count = 1
    while (result.kind !== 'complete' && count < 100) {
      result = feed(decoder, encoder.nextPart())
      count++
    }
    expect(result.kind).toBe('complete')
    expect(count).toBe(9)
    if (result.kind === 'complete') expect(hex(result.message)).toBe(hex(message))
  })

  // The reason fountain coding exists: the receiver misses frames and the sender never learns
  // which. Dropping every other part forces the mixed-part reduction to carry the message.
  it('recovers when every other part is dropped', () => {
    const message = makeMessage(1024)
    const encoder = fountainEncoder(message, 'bytes', 100)
    const decoder = fountainDecoder()

    let result: ReturnType<typeof feed> = {kind: 'accepted'}
    for (let i = 0; i < 400 && result.kind !== 'complete'; i++) {
      const part = encoder.nextPart()
      if (i % 2 === 0) continue
      result = feed(decoder, part)
    }
    expect(result.kind).toBe('complete')
    if (result.kind === 'complete') expect(hex(result.message)).toBe(hex(message))
  })

  /**
   * The hard case: admit **only parts carrying two or more fragments**, so the message can be
   * solved solely by cancelling mixes against each other. This is what forces the reduction
   * cascade — nothing else in this suite does.
   *
   * ⚠️ Filter on *degree*, not on `seqNum > seqLen`. Those are not the same thing: `chooseDegree`
   * returns 1 often, so the stream past `seqLen` is full of single-fragment parts (the reference's
   * own vectors show 12→{9}, 14→{8}, 16→{1}). An earlier version of this test filtered by
   * sequence number, collected those degree-1 parts, and passed with the cascade deleted.
   */
  it('recovers from genuinely mixed parts alone', () => {
    const message = makeMessage(600)
    const encoder = fountainEncoder(message, 'bytes', 60)
    const {seqLen, checksum} = encoder
    const decoder = fountainDecoder()

    let admitted = 0
    let result: ReturnType<typeof feed> = {kind: 'accepted'}
    for (let i = 0; i < 5000 && result.kind !== 'complete'; i++) {
      const parsed = decodeUr(encoder.nextPart())
      if (!parsed.ok || !isMultiPart(parsed.value)) throw new Error('unexpected')
      if (chooseFragments(parsed.value.seqNum, seqLen, checksum).length < 2) continue
      admitted++
      result = decoder.receivePart(parsed.value.cbor)
    }
    expect(result.kind).toBe('complete')
    if (result.kind === 'complete') expect(hex(result.message)).toBe(hex(message))
    // Every fragment came out of the reduction, since no part carried one on its own.
    expect(admitted).toBeGreaterThan(0)
  })

  /**
   * Completing is not enough — it has to complete *soon*.
   *
   * With an unbounded stream a decoder that throws away work still finishes eventually, because
   * later parts re-derive it. So no correctness assertion can catch a broken reduction cascade;
   * only a budget can. On a device the budget is real: it is how long the user holds the phone up.
   *
   * The numbers are deterministic (fixed seed, deterministic RNG), so this is a guard rather than
   * a flaky benchmark. Measured 2026-08-06: 19 parts as written, 45 with the cascade in `absorb`
   * disabled. The ceiling sits between the two.
   */
  it('converges within a part budget, not merely eventually', () => {
    const message = makeMessage(1024)
    const encoder = fountainEncoder(message, 'bytes', 80)
    const {seqLen, checksum} = encoder
    const decoder = fountainDecoder()
    const BUDGET = 30

    let admitted = 0
    let result: ReturnType<typeof feed> = {kind: 'accepted'}
    for (let i = 0; i < 20000 && result.kind !== 'complete' && admitted < BUDGET; i++) {
      const parsed = decodeUr(encoder.nextPart())
      if (!parsed.ok || !isMultiPart(parsed.value)) throw new Error('unexpected')
      if (chooseFragments(parsed.value.seqNum, seqLen, checksum).length < 2) continue
      admitted++
      result = decoder.receivePart(parsed.value.cbor)
    }
    expect(result.kind).toBe('complete')
    expect(admitted).toBeLessThanOrEqual(BUDGET)
  })

  /**
   * `AnimatedQRCode` renders every frame uppercased, because QR alphanumeric mode has no lowercase
   * and the canonical spelling costs a symbol version or two. Nothing downstream may care — so the
   * stream is decoded here in exactly the form the screen shows, not the form the encoder returns.
   */
  it('decodes the uppercase form the screen presents', () => {
    const message = makeMessage(512)
    const encoder = fountainEncoder(message, 'crypto-multi-accounts', 50)
    const decoder = fountainDecoder()

    let result: ReturnType<typeof feed> = {kind: 'accepted'}
    for (let i = 0; i < 40 && result.kind !== 'complete'; i++) {
      const presented = encoder.nextPart().toUpperCase()
      expect(presented).toMatch(/^UR:CRYPTO-MULTI-ACCOUNTS\/\d+-\d+\/[A-Z]+$/)
      result = feed(decoder, presented)
    }
    expect(result.kind).toBe('complete')
    if (result.kind === 'complete') expect(hex(result.message)).toBe(hex(message))
  })

  it('survives a message that is an exact multiple of the fragment length', () => {
    const message = makeMessage(300)
    const encoder = fountainEncoder(message, 'bytes', 100)
    const decoder = fountainDecoder()
    let result: ReturnType<typeof feed> = {kind: 'accepted'}
    for (let i = 0; i < 50 && result.kind !== 'complete'; i++) result = feed(decoder, encoder.nextPart())
    expect(result.kind).toBe('complete')
    if (result.kind === 'complete') expect(hex(result.message)).toBe(hex(message))
  })

  it('reports progress that only ever moves forward', () => {
    const encoder = fountainEncoder(makeMessage(512), 'bytes', 50)
    const decoder = fountainDecoder()
    expect(decoder.progress()).toEqual({received: 0, expected: undefined, fraction: 0})
    let previous = 0
    for (let i = 0; i < 30 && !decoder.isComplete(); i++) {
      feed(decoder, encoder.nextPart())
      const {fraction} = decoder.progress()
      expect(fraction).toBeGreaterThanOrEqual(previous)
      previous = fraction
    }
    expect(decoder.isComplete()).toBe(true)
    expect(decoder.progress().fraction).toBe(1)
  })
})

describe('the decoder defends itself', () => {
  it('reports a part from a different message as fatal', () => {
    const a = fountainEncoder(makeMessage(256, 'Wolf'), 'bytes', 30)
    const b = fountainEncoder(makeMessage(256, 'Fox'), 'bytes', 30)
    const decoder = fountainDecoder()
    expect(feed(decoder, a.nextPart()).kind).toBe('accepted')
    const result = feed(decoder, b.nextPart())
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') expect(result.fatal).toBe(true)
  })

  it('calls a repeated part redundant rather than counting it twice', () => {
    const encoder = fountainEncoder(makeMessage(256), 'bytes', 30)
    const decoder = fountainDecoder()
    const part = encoder.nextPart()
    expect(feed(decoder, part).kind).toBe('accepted')
    expect(feed(decoder, part).kind).toBe('redundant')
    expect(decoder.progress().received).toBe(1)
  })

  it('rejects garbage without throwing', () => {
    const decoder = fountainDecoder()
    const result = decoder.receivePart(Uint8Array.from([0xff, 0xff, 0xff]))
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') expect(result.fatal).toBe(false)
  })

  // The Bytewords CRC covers each frame; only this check covers the assembled whole.
  it('refuses an assembled message whose checksum does not match', () => {
    const message = makeMessage(256)
    const encoder = fountainEncoder(message, 'bytes', 30)
    const decoder = fountainDecoder()
    const parts: Uint8Array[] = []
    for (let i = 0; i < 9; i++) {
      const parsed = decodeUr(encoder.nextPart())
      if (!parsed.ok || !isMultiPart(parsed.value)) throw new Error('unexpected')
      parts.push(parsed.value.cbor)
    }
    // Corrupt the last fragment's payload while keeping the header consistent.
    const last = decodePart(parts[8] as Uint8Array)
    if (!last.ok) throw new Error('unexpected')
    const tampered = Uint8Array.from(last.part.data)
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    parts[8] = encodePart({...last.part, data: tampered})

    let result: ReturnType<typeof decoder.receivePart> = {kind: 'accepted'}
    for (const part of parts) result = decoder.receivePart(part)
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') expect(result.reason).toMatch(/checksum/)
  })

  it('can be reset and reused', () => {
    const message = makeMessage(256)
    const encoder = fountainEncoder(message, 'bytes', 30)
    const decoder = fountainDecoder()
    feed(decoder, encoder.nextPart())
    expect(decoder.progress().received).toBe(1)
    decoder.reset()
    expect(decoder.progress()).toEqual({received: 0, expected: undefined, fraction: 0})

    const fresh = fountainEncoder(message, 'bytes', 30)
    let result: ReturnType<typeof feed> = {kind: 'accepted'}
    for (let i = 0; i < 20 && result.kind !== 'complete'; i++) result = feed(decoder, fresh.nextPart())
    expect(result.kind).toBe('complete')
    if (result.kind === 'complete') expect(crc32(result.message)).toBe(crc32(message))
  })
})
