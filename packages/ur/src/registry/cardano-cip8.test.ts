import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {describe, expect, it} from 'vitest'
import {TAG_CRYPTO_KEYPATH, TAG_UUID} from './cardano.js'
import {
  type CardanoSignCip8DataRequest,
  decodeCardanoSignCip8DataRequest,
  decodeCardanoSignCip8DataSignature,
  encodeCardanoSignCip8DataRequest,
  encodeCardanoSignCip8DataSignature,
} from './cardano-cip8.js'

const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill)

const shelleyPath = {
  components: [
    {index: 1852, hardened: true},
    {index: 1815, hardened: true},
    {index: 0, hardened: true},
    {index: 0, hardened: false},
    {index: 3, hardened: false},
  ],
  sourceFingerprint: 0x1250b6bc,
  depth: 5,
}

const request: CardanoSignCip8DataRequest = {
  requestId: bytes(16, 0xab),
  signData: bytes(24, 0x5a),
  derivationPath: shelleyPath,
  origin: 'eternl',
  xpub: bytes(64, 0x77),
  hashPayload: false,
  addressBech32: 'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw',
  addressFieldType: 'ADDRESS',
}

type Write = (s: InstanceType<typeof Cbor.Serializer>) => void

/**
 * Rebuild the request map with entries replaced, added or dropped, to reach shapes the encoder
 * cannot produce. The minimum viable request is KEY_HASH mode, which needs no address.
 */
const requestWith = (overrides: Record<number, Write> = {}, omit: readonly number[] = []): Uint8Array => {
  const map: Record<number, Write> = {
    2: (s) => s.writeBytes(request.signData),
    3: (s) => {
      s.writeTag(TAG_CRYPTO_KEYPATH).writeMap(Cbor.len(1)).writeUnsignedInteger(1).writeArray(Cbor.len(2))
      s.writeUnsignedInteger(1852).writeSpecial(Cbor.Special.Bool, true)
    },
    6: (s) => s.writeBytes(request.xpub),
    7: (s) => s.writeSpecial(Cbor.Special.Bool, true),
    9: (s) => s.writeText('KEY_HASH'),
    ...overrides,
  }
  for (const key of omit) delete map[key]
  const keys = Object.keys(map)
    .map(Number)
    .sort((a, b) => a - b)
  const serializer = Cbor.Serializer.newVec().writeMap(Cbor.len(keys.length))
  for (const key of keys) {
    serializer.writeUnsignedInteger(key)
    map[key]?.(serializer)
  }
  return serializer.finalize()
}

describe('cardano-sign-cip8-data-request', () => {
  it('round-trips every field', () => {
    const decoded = decodeCardanoSignCip8DataRequest(encodeCardanoSignCip8DataRequest(request))
    expect(decoded).toEqual({ok: true, value: request})
  })

  it('round-trips KEY_HASH mode, which carries no address', () => {
    const keyHashMode: CardanoSignCip8DataRequest = {
      signData: bytes(8, 1),
      derivationPath: shelleyPath,
      xpub: bytes(64, 2),
      hashPayload: true,
      addressFieldType: 'KEY_HASH',
    }
    const decoded = decodeCardanoSignCip8DataRequest(encodeCardanoSignCip8DataRequest(keyHashMode))
    expect(decoded).toEqual({ok: true, value: keyHashMode})
  })

  it('reads addressFieldType as text, not as an enum ordinal', () => {
    // The published source writes the string. A reimplementation that guessed a uint would still
    // round-trip against itself, so this asserts the wire form directly.
    const encoded = encodeCardanoSignCip8DataRequest(request)
    expect(new TextDecoder().decode(encoded)).toContain('ADDRESS')
  })

  it('tolerates signType, which the reference declares but never writes', () => {
    const withSignType = requestWith({5: (s) => s.writeUnsignedInteger(1)})
    const decoded = decodeCardanoSignCip8DataRequest(withSignType)
    expect(decoded.ok).toBe(true)
  })

  it('refuses an unknown addressFieldType rather than guessing', () => {
    const decoded = decodeCardanoSignCip8DataRequest(requestWith({9: (s) => s.writeText('SOMETHING_NEW')}))
    expect(decoded).toEqual({ok: false, error: expect.stringContaining('unknown addressFieldType')})
  })

  it('refuses ADDRESS mode with no address', () => {
    const decoded = decodeCardanoSignCip8DataRequest(requestWith({9: (s) => s.writeText('ADDRESS')}))
    expect(decoded).toEqual({ok: false, error: expect.stringContaining('ADDRESS mode with no address')})
  })

  it('refuses an xpub that is not 64 bytes', () => {
    const decoded = decodeCardanoSignCip8DataRequest(requestWith({6: (s) => s.writeBytes(bytes(32, 9))}))
    expect(decoded).toEqual({ok: false, error: expect.stringContaining('64 bytes, got 32')})
  })

  it('refuses an empty payload', () => {
    const decoded = decodeCardanoSignCip8DataRequest(requestWith({2: (s) => s.writeBytes(new Uint8Array())}))
    expect(decoded).toEqual({ok: false, error: expect.stringContaining('nothing to sign')})
  })

  it('accepts the minimum viable request, so the omission cases below mean something', () => {
    expect(decodeCardanoSignCip8DataRequest(requestWith()).ok).toBe(true)
  })

  it.each([
    ['signData', 2],
    ['derivationPath', 3],
    ['xpub', 6],
    ['hashPayload', 7],
    ['addressFieldType', 9],
  ])('refuses a request missing %s', (name, key) => {
    expect(decodeCardanoSignCip8DataRequest(requestWith({}, [key]))).toEqual({
      ok: false,
      error: expect.stringContaining(name),
    })
  })

  it('refuses a wildcard path, which resolves to no single key', () => {
    const wildcard = requestWith({
      3: (s) => {
        s.writeTag(TAG_CRYPTO_KEYPATH).writeMap(Cbor.len(1)).writeUnsignedInteger(1).writeArray(Cbor.len(2))
        s.writeArray(Cbor.len(0)).writeSpecial(Cbor.Special.Bool, true)
      },
    })
    expect(decodeCardanoSignCip8DataRequest(wildcard)).toEqual({
      ok: false,
      error: expect.stringContaining('wildcard'),
    })
  })
})

describe('cardano-sign-cip8-data-signature', () => {
  it('round-trips with a request id', () => {
    const reply = {requestId: bytes(16, 0xcd), signature: bytes(64, 0x01), publicKey: bytes(44, 0x02)}
    expect(decodeCardanoSignCip8DataSignature(encodeCardanoSignCip8DataSignature(reply))).toEqual({
      ok: true,
      value: reply,
    })
  })

  it('round-trips without one', () => {
    const reply = {signature: bytes(64, 0x03), publicKey: bytes(44, 0x04)}
    expect(decodeCardanoSignCip8DataSignature(encodeCardanoSignCip8DataSignature(reply))).toEqual({
      ok: true,
      value: reply,
    })
  })

  it('tags the request id as a uuid', () => {
    const encoded = encodeCardanoSignCip8DataSignature({
      requestId: bytes(16, 0xcd),
      signature: bytes(8, 1),
      publicKey: bytes(8, 2),
    })
    const cursor = Cbor.Deserializer.from(encoded)
    cursor.map()
    expect(Number(cursor.unsignedInteger())).toBe(1)
    expect(Number(cursor.tag())).toBe(TAG_UUID)
  })

  it('refuses a reply with no public key', () => {
    const serializer = Cbor.Serializer.newVec().writeMap(Cbor.len(1))
    serializer.writeUnsignedInteger(2).writeBytes(bytes(64, 1))
    expect(decodeCardanoSignCip8DataSignature(serializer.finalize())).toEqual({
      ok: false,
      error: expect.stringContaining('missing publicKey'),
    })
  })
})
