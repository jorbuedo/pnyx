import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {describe, expect, it} from 'vitest'
import {cborReader, readMapEntries} from '../cbor-read.js'
import {TAG_CRYPTO_KEYPATH} from './cardano.js'
import {
  COIN_TYPE_CARDANO,
  decodeMultiAccounts,
  encodeMultiAccounts,
  TAG_CRYPTO_HDKEY,
  TAG_CRYPTO_MULTI_ACCOUNTS,
} from './hdkey.js'

const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill)

const cardanoAccount0 = {
  keyData: bytes(32, 0xaa),
  chainCode: bytes(32, 0xbb),
  origin: {
    components: [
      {index: 1852, hardened: true},
      {index: 1815, hardened: true},
      {index: 0, hardened: true},
    ],
    sourceFingerprint: 0x1250b6bc,
    depth: 3,
  },
  parentFingerprint: 0x1250b6bc,
  name: 'Abandon Preprod',
}

/** Read the encoding back with the same primitives the decoder side uses. */
const parse = (cbor: Uint8Array) => {
  const cursor = cborReader(cbor)
  const out: Record<string, unknown> = {}
  readMapEntries(cursor, (key) => {
    switch (key) {
      case 1:
        out.masterFingerprint = Number(cursor.unsignedInteger())
        return true
      case 2: {
        const length = cursor.array()
        if (typeof length === 'string') throw new Error('expected a definite array')
        out.keys = Array.from({length: length.definite}, () => {
          expect(Number(cursor.tag())).toBe(TAG_CRYPTO_HDKEY)
          const key: Record<string, unknown> = {}
          readMapEntries(cursor, (k) => {
            switch (k) {
              case 1:
                key.isMaster = cursor.bool()
                return true
              case 2:
                key.isPrivate = cursor.bool()
                return true
              case 3:
                key.keyData = cursor.bytes().length
                return true
              case 4:
                key.chainCode = cursor.bytes().length
                return true
              case 6: {
                expect(Number(cursor.tag())).toBe(TAG_CRYPTO_KEYPATH)
                const path: number[] = []
                readMapEntries(cursor, (pk) => {
                  if (pk === 1) {
                    const len = cursor.array()
                    if (typeof len === 'string') throw new Error('expected a definite array')
                    for (let i = 0; i < len.definite / 2; i++) {
                      path.push(Number(cursor.unsignedInteger()))
                      cursor.bool()
                    }
                    return true
                  }
                  if (pk === 2) {
                    key.sourceFingerprint = Number(cursor.unsignedInteger())
                    return true
                  }
                  if (pk === 3) {
                    key.depth = Number(cursor.unsignedInteger())
                    return true
                  }
                  return false
                })
                key.path = path
                return true
              }
              case 8:
                key.parentFingerprint = Number(cursor.unsignedInteger())
                return true
              case 9:
                key.name = cursor.text()
                return true
              default:
                return false
            }
          })
          return key
        })
        return true
      }
      case 3:
        out.device = cursor.text()
        return true
      case 5:
        out.version = cursor.text()
        return true
      default:
        return false
    }
  })
  return out
}

describe('crypto-multi-accounts', () => {
  it('uses the published tags', () => {
    expect([TAG_CRYPTO_HDKEY, TAG_CRYPTO_MULTI_ACCOUNTS]).toEqual([303, 1103])
  })

  it('encodes an account key with its derivation path', () => {
    const parsed = parse(
      encodeMultiAccounts({
        masterFingerprint: 0x1250b6bc,
        keys: [cardanoAccount0],
        device: 'Pnyx',
        version: '1',
      }),
    )
    expect(parsed.masterFingerprint).toBe(0x1250b6bc)
    expect(parsed.device).toBe('Pnyx')
    expect(parsed.version).toBe('1')
    expect(parsed.keys).toEqual([
      {
        keyData: 32,
        chainCode: 32,
        path: [1852, 1815, 0],
        sourceFingerprint: 0x1250b6bc,
        depth: 3,
        parentFingerprint: 0x1250b6bc,
        name: 'Abandon Preprod',
      },
    ])
  })

  /**
   * BCR-2020-007 gives `is-master` and `is-private` a CDDL default of false, so a public derived
   * key omits them. Writing `false` explicitly is legal but not canonical, and a reader that
   * treats a present key as meaningful would see a difference.
   */
  it('omits isMaster and isPrivate rather than writing false', () => {
    const parsed = parse(encodeMultiAccounts({masterFingerprint: 1, keys: [cardanoAccount0]}))
    const [key] = parsed.keys as Record<string, unknown>[]
    expect(key).toBeDefined()
    expect('isMaster' in (key ?? {})).toBe(false)
    expect('isPrivate' in (key ?? {})).toBe(false)
  })

  it('carries several accounts', () => {
    const parsed = parse(
      encodeMultiAccounts({
        masterFingerprint: 7,
        keys: [
          cardanoAccount0,
          {
            ...cardanoAccount0,
            name: 'Account 1',
            origin: {...cardanoAccount0.origin, components: [{index: 1852, hardened: true}]},
          },
        ],
      }),
    )
    expect((parsed.keys as unknown[]).length).toBe(2)
  })

  it('omits the optional device fields when absent', () => {
    const parsed = parse(encodeMultiAccounts({masterFingerprint: 1, keys: [cardanoAccount0]}))
    expect(parsed.device).toBeUndefined()
    expect(parsed.version).toBeUndefined()
  })

  it('refuses an empty export', () => {
    expect(() => encodeMultiAccounts({masterFingerprint: 1, keys: []})).toThrow(/nothing to export/)
  })

  it('produces CBOR the general reader accepts', () => {
    const encoded = encodeMultiAccounts({masterFingerprint: 1, keys: [cardanoAccount0]})
    expect(Cbor.Deserializer.from(encoded).cborType()).toBe(Cbor.CborType.Map)
  })
})

describe('decodeMultiAccounts', () => {
  // ⚠️ Round-tripped through our own encoder on purpose: that encoder is the one an Eternl extension
  // read and rendered correctly in both directions, so it is the closest thing to a device-produced
  // sample we have. A hand-built fixture would only pin this reader to my reading of the spec.
  it('reads back what our export writes', () => {
    const exported = {
      masterFingerprint: 0x1250b6bc,
      keys: [cardanoAccount0],
      device: 'Pnyx',
      deviceId: 'pnyx-1',
      version: '1',
    }
    const decoded = decodeMultiAccounts(encodeMultiAccounts(exported))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value.masterFingerprint).toBe(exported.masterFingerprint)
    expect(decoded.value.device).toBe('Pnyx')
    expect(decoded.value.keys).toHaveLength(1)
    const [key] = decoded.value.keys
    expect(key?.keyData).toEqual(cardanoAccount0.keyData)
    expect(key?.chainCode).toEqual(cardanoAccount0.chainCode)
    expect(key?.origin.components).toEqual(cardanoAccount0.origin.components)
  })

  // ⚠️ **Raw, not converted.** BCR numbers mainnet 0 and Cardano numbers it 1, and our reading of that
  // direction has only ever been exercised on preprod — where a consistently inverted reading looks
  // exactly like a correct one. Converting here would bury that.
  it('returns the network in BCR numbering, without inverting it', () => {
    const withInfo = {...cardanoAccount0, useInfo: {type: COIN_TYPE_CARDANO, network: 1}}
    const decoded = decodeMultiAccounts(encodeMultiAccounts({masterFingerprint: 1, keys: [withInfo]}))
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.value.keys[0]?.useInfo).toEqual({type: COIN_TYPE_CARDANO, network: 1})
  })

  // A device sending a field this reader does not need is still an export we can act on.
  it('skips map keys it has no use for', () => {
    const serializer = Cbor.Serializer.newVec()
      .writeMap(Cbor.len(2))
      .writeUnsignedInteger(1)
      .writeUnsignedInteger(7)
      .writeUnsignedInteger(2)
      .writeArray(Cbor.len(1))
    serializer.writeTag(TAG_CRYPTO_HDKEY).writeMap(Cbor.len(4))
    // 1 isMaster — present and false, which the canonical encoding omits.
    serializer.writeUnsignedInteger(1).writeSpecial(Cbor.Special.Bool, false)
    serializer.writeUnsignedInteger(3).writeBytes(bytes(32, 0x11))
    serializer.writeUnsignedInteger(4).writeBytes(bytes(32, 0x22))
    serializer.writeUnsignedInteger(6).writeTag(TAG_CRYPTO_KEYPATH).writeMap(Cbor.len(1))
    serializer.writeUnsignedInteger(1).writeArray(Cbor.len(2))
    serializer.writeUnsignedInteger(1852).writeSpecial(Cbor.Special.Bool, true)
    const decoded = decodeMultiAccounts(serializer.finalize())
    expect(decoded.ok).toBe(true)
  })

  // ⚠️ Required by us rather than by the spec: without a path there is no way to know whether a key is
  // the payment account, the stake account or a CIP-1854 one, and guessing assigns it to the wrong role.
  it('refuses a key with no origin path', () => {
    const serializer = Cbor.Serializer.newVec()
      .writeMap(Cbor.len(2))
      .writeUnsignedInteger(1)
      .writeUnsignedInteger(7)
      .writeUnsignedInteger(2)
      .writeArray(Cbor.len(1))
    serializer.writeTag(TAG_CRYPTO_HDKEY).writeMap(Cbor.len(2))
    serializer.writeUnsignedInteger(3).writeBytes(bytes(32, 0x11))
    serializer.writeUnsignedInteger(4).writeBytes(bytes(32, 0x22))
    const decoded = decodeMultiAccounts(serializer.finalize())
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.error).toContain('origin')
  })

  it('refuses an export with no keys, rather than returning an empty wallet', () => {
    const empty = Cbor.Serializer.newVec()
      .writeMap(Cbor.len(2))
      .writeUnsignedInteger(1)
      .writeUnsignedInteger(7)
      .writeUnsignedInteger(2)
      .writeArray(Cbor.len(0))
      .finalize()
    expect(decodeMultiAccounts(empty).ok).toBe(false)
  })
})
