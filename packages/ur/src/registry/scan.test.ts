import {describe, expect, it} from 'vitest'
import {fountainDecoder} from '../fountain-decoder.js'
import {fountainEncoder} from '../fountain-encoder.js'
import {decodeUr, isMultiPart} from '../ur.js'
import {encodeCardanoSignRequest, UR_TYPE_SIGN_REQUEST, UR_TYPE_SIGN_TX_HASH_REQUEST} from './cardano.js'
import {classifyScannedUr} from './scan.js'

const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill)

const request = {
  requestId: bytes(16, 0xab),
  // Big enough to force a real multi-frame sequence rather than a single part.
  signData: bytes(900, 0x5a),
  utxos: [
    {
      transactionHash: bytes(32, 0x11),
      index: 0,
      amount: '2000000',
      keyPath: {
        components: [
          {index: 1852, hardened: true},
          {index: 1815, hardened: true},
          {index: 0, hardened: true},
          {index: 0, hardened: false},
          {index: 0, hardened: false},
        ],
        sourceFingerprint: 0x1250b6bc,
      },
      address: 'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7s',
    },
  ],
  extraSigners: [],
  origin: 'some-desktop-wallet',
}

describe('classifying a scanned UR', () => {
  it('recognises a sign request', () => {
    const result = classifyScannedUr({type: UR_TYPE_SIGN_REQUEST, cbor: encodeCardanoSignRequest(request)})
    expect(result.kind).toBe('cardano-sign-request')
    if (result.kind === 'cardano-sign-request') expect(result.request.origin).toBe('some-desktop-wallet')
  })

  // Refused rather than warned: there is nothing to review, so a review screen would be a lie.
  it('refuses a tx-hash-only request', () => {
    const result = classifyScannedUr({type: UR_TYPE_SIGN_TX_HASH_REQUEST, cbor: bytes(4, 1)})
    expect(result.kind).toBe('refused-tx-hash-only')
  })

  it('reports an unrelated UR type as unsupported rather than malformed', () => {
    const result = classifyScannedUr({type: 'crypto-psbt', cbor: bytes(4, 1)})
    expect(result).toEqual({kind: 'unsupported', urType: 'crypto-psbt'})
  })

  it('separates a malformed payload from an unsupported type', () => {
    const result = classifyScannedUr({type: UR_TYPE_SIGN_REQUEST, cbor: bytes(4, 0xff)})
    expect(result.kind).toBe('malformed')
  })
})

/** The whole receive path a device drives: animated QR in, parsed request out. */
describe('end-to-end through the fountain transport', () => {
  it('reassembles a multi-frame sign request', () => {
    const payload = encodeCardanoSignRequest(request)
    const encoder = fountainEncoder(payload, UR_TYPE_SIGN_REQUEST, 120)
    expect(encoder.seqLen).toBeGreaterThan(1)

    const decoder = fountainDecoder()
    let message: Uint8Array | undefined
    for (let i = 0; i < 200 && message === undefined; i++) {
      const parsed = decodeUr(encoder.nextPart())
      if (!parsed.ok || !isMultiPart(parsed.value)) throw new Error('expected a multi-part UR')
      const result = decoder.receivePart(parsed.value.cbor)
      if (result.kind === 'complete') message = result.message
    }
    expect(message).toBeDefined()
    if (message === undefined) return

    const classified = classifyScannedUr({type: UR_TYPE_SIGN_REQUEST, cbor: message})
    expect(classified.kind).toBe('cardano-sign-request')
    if (classified.kind !== 'cardano-sign-request') return
    expect(Array.from(classified.request.signData)).toEqual(Array.from(request.signData))
    expect(classified.request.utxos[0]?.address).toBe(request.utxos[0]?.address)
  })

  // Dropping frames is the normal case for a camera, not the exception.
  it('reassembles when most frames are missed', () => {
    const payload = encodeCardanoSignRequest(request)
    const encoder = fountainEncoder(payload, UR_TYPE_SIGN_REQUEST, 120)
    const decoder = fountainDecoder()

    let message: Uint8Array | undefined
    for (let i = 0; i < 2000 && message === undefined; i++) {
      const part = encoder.nextPart()
      if (i % 3 !== 0) continue
      const parsed = decodeUr(part)
      if (!parsed.ok || !isMultiPart(parsed.value)) throw new Error('expected a multi-part UR')
      const result = decoder.receivePart(parsed.value.cbor)
      if (result.kind === 'complete') message = result.message
    }
    expect(message).toBeDefined()
    if (message !== undefined) {
      expect(classifyScannedUr({type: UR_TYPE_SIGN_REQUEST, cbor: message}).kind).toBe('cardano-sign-request')
    }
  })
})
