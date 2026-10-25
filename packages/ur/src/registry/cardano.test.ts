import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {describe, expect, it} from 'vitest'
import {cborReader, readMapEntries} from '../cbor-read.js'
import {
  type CardanoSignRequest,
  decodeCardanoSignature,
  decodeCardanoSignRequest,
  encodeCardanoSignature,
  encodeCardanoSignRequest,
  encodeCardanoSignTxHashRequest,
  formatKeyPath,
  readKeypath,
  TAG_CARDANO_SIGN_REQUEST,
  TAG_CARDANO_SIGN_TX_HASH_REQUEST,
  TAG_CARDANO_UTXO,
  TAG_CRYPTO_KEYPATH,
  TAG_UUID,
} from './cardano.js'

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

const utxo0: CardanoSignRequest['utxos'][number] = {
  transactionHash: bytes(32, 0x11),
  index: 3,
  amount: '10000000',
  keyPath: shelleyPath,
  address: 'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw',
}

const request: CardanoSignRequest = {
  requestId: bytes(16, 0xab),
  signData: Uint8Array.from([0xa4, 0x00, 0x81, 0x82]),
  utxos: [utxo0],
  extraSigners: [{keyHash: bytes(28, 0x22), keyPath: shelleyPath}],
  origin: 'cardano-wallet',
}

describe('registry tags', () => {
  // Read off @keystonehq/bc-ur-registry-cardano@0.5.0 rather than inferred. A wrong number here
  // fails silently against a real device, so pin them.
  it('are the published values', () => {
    expect([TAG_UUID, TAG_CRYPTO_KEYPATH, TAG_CARDANO_UTXO, TAG_CARDANO_SIGN_REQUEST]).toEqual([37, 304, 2201, 2202])
    expect(TAG_CARDANO_SIGN_TX_HASH_REQUEST).toBe(2212)
  })
})

describe('cardano-sign-request', () => {
  it('round-trips every field', () => {
    const decoded = decodeCardanoSignRequest(encodeCardanoSignRequest(request))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value.origin).toBe('cardano-wallet')
    expect(Array.from(decoded.value.requestId ?? [])).toEqual(Array.from(request.requestId ?? []))
    expect(Array.from(decoded.value.signData)).toEqual(Array.from(request.signData))
    expect(decoded.value.utxos).toHaveLength(1)
    expect(decoded.value.extraSigners).toHaveLength(1)
    const [utxo] = decoded.value.utxos
    expect(utxo?.amount).toBe('10000000')
    expect(utxo?.index).toBe(3)
    expect(utxo?.address).toBe(request.utxos[0]?.address)
    expect(formatKeyPath(utxo?.keyPath ?? {components: []})).toBe("m/1852'/1815'/0'/0/3")
    expect(utxo?.keyPath.sourceFingerprint).toBe(0x1250b6bc)
  })

  it('round-trips without the optional fields', () => {
    const minimal: CardanoSignRequest = {signData: Uint8Array.from([1, 2, 3]), utxos: [], extraSigners: []}
    const decoded = decodeCardanoSignRequest(encodeCardanoSignRequest(minimal))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value.requestId).toBeUndefined()
    expect(decoded.value.origin).toBeUndefined()
    expect(decoded.value.utxos).toEqual([])
  })

  // A newer device may add keys. Rejecting the whole request over one would refuse work we can do.
  it('skips map keys it does not know', () => {
    const withExtra = Cbor.Serializer.newVec()
      .writeMap(Cbor.len(4))
      .writeUnsignedInteger(2)
      .writeBytes(Uint8Array.from([9, 9]))
      .writeUnsignedInteger(3)
      .writeArray(Cbor.len(0))
      .writeUnsignedInteger(4)
      .writeArray(Cbor.len(0))
      // An unknown key holding a nested structure, to exercise the skip rather than a scalar.
      .writeUnsignedInteger(99)
      .writeMap(Cbor.len(1))
      .writeUnsignedInteger(1)
      .writeArray(Cbor.len(2))
      .writeText('a')
      .writeSpecial(Cbor.Special.Bool, true)
      .finalize()
    const decoded = decodeCardanoSignRequest(withExtra)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(Array.from(decoded.value.signData)).toEqual([9, 9])
  })
})

describe('cardano-signature', () => {
  it('round-trips', () => {
    const decoded = decodeCardanoSignature(
      encodeCardanoSignature({requestId: bytes(16, 0xcd), witnessSet: bytes(64, 0xee)}),
    )
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value.witnessSet).toHaveLength(64)
    expect(decoded.value.requestId).toHaveLength(16)
  })

  it('round-trips without a request id', () => {
    const decoded = decodeCardanoSignature(encodeCardanoSignature({witnessSet: bytes(8, 1)}))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.value.requestId).toBeUndefined()
  })

  it('rejects a signature with no witness set', () => {
    const empty = Cbor.Serializer.newVec().writeMap(Cbor.len(0)).finalize()
    expect(decodeCardanoSignature(empty).ok).toBe(false)
  })
})

describe('rejects malformed and hostile input', () => {
  const expectFailure = (cbor: Uint8Array, pattern: RegExp) => {
    const decoded = decodeCardanoSignRequest(cbor)
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error).toMatch(pattern)
  }

  it('rejects a request with no signData', () => {
    const noSignData = Cbor.Serializer.newVec()
      .writeMap(Cbor.len(1))
      .writeUnsignedInteger(3)
      .writeArray(Cbor.len(0))
      .finalize()
    expectFailure(noSignData, /no signData/)
  })

  it('rejects empty signData — there would be nothing to review', () => {
    expectFailure(encodeCardanoSignRequest({signData: new Uint8Array(), utxos: [], extraSigners: []}), /empty/)
  })

  it('rejects a UTxO whose transaction hash is the wrong size', () => {
    const bad = encodeCardanoSignRequest({
      ...request,
      utxos: [{...utxo0, transactionHash: bytes(16, 1)}],
    })
    expectFailure(bad, /32 bytes/)
  })

  it('rejects a non-numeric amount rather than coercing it', () => {
    const bad = encodeCardanoSignRequest({...request, utxos: [{...utxo0, amount: '1e9'}]})
    expectFailure(bad, /not a whole number/)
  })

  it('rejects a cert key whose hash is the wrong size', () => {
    const bad = encodeCardanoSignRequest({...request, extraSigners: [{keyHash: bytes(20, 2), keyPath: shelleyPath}]})
    expectFailure(bad, /28 bytes/)
  })

  // A wildcard path resolves to many keys. A signer needs exactly one.
  it('rejects a wildcard key path', () => {
    const wildcard = Cbor.Serializer.newVec()
      .writeMap(Cbor.len(3))
      .writeUnsignedInteger(2)
      .writeBytes(Uint8Array.from([1]))
      .writeUnsignedInteger(4)
      .writeArray(Cbor.len(0))
      .writeUnsignedInteger(3)
      .writeArray(Cbor.len(1))
      .writeTag(TAG_CARDANO_UTXO)
      .writeMap(Cbor.len(5))
      .writeUnsignedInteger(1)
      .writeBytes(bytes(32, 1))
      .writeUnsignedInteger(2)
      .writeUnsignedInteger(0)
      .writeUnsignedInteger(3)
      .writeText('1')
      .writeUnsignedInteger(4)
      .writeTag(TAG_CRYPTO_KEYPATH)
      .writeMap(Cbor.len(1))
      .writeUnsignedInteger(1)
      .writeArray(Cbor.len(2))
      .writeArray(Cbor.len(0)) // the wildcard
      .writeSpecial(Cbor.Special.Bool, false)
      .writeUnsignedInteger(5)
      .writeText('addr1')
      .finalize()
    expectFailure(wildcard, /wildcard/)
  })

  it('rejects a keypath whose components are not pairs', () => {
    const odd = Cbor.Serializer.newVec()
      .writeMap(Cbor.len(3))
      .writeUnsignedInteger(2)
      .writeBytes(Uint8Array.from([1]))
      .writeUnsignedInteger(4)
      .writeArray(Cbor.len(0))
      .writeUnsignedInteger(3)
      .writeArray(Cbor.len(1))
      .writeTag(TAG_CARDANO_UTXO)
      .writeMap(Cbor.len(5))
      .writeUnsignedInteger(1)
      .writeBytes(bytes(32, 1))
      .writeUnsignedInteger(2)
      .writeUnsignedInteger(0)
      .writeUnsignedInteger(3)
      .writeText('1')
      .writeUnsignedInteger(4)
      .writeTag(TAG_CRYPTO_KEYPATH)
      .writeMap(Cbor.len(1))
      .writeUnsignedInteger(1)
      .writeArray(Cbor.len(3))
      .writeUnsignedInteger(1852)
      .writeSpecial(Cbor.Special.Bool, true)
      .writeUnsignedInteger(1815)
      .writeUnsignedInteger(5)
      .writeText('addr1')
      .finalize()
    expectFailure(odd, /pairs/)
  })

  it('rejects a wrongly-tagged utxo', () => {
    const wrongTag = Cbor.Serializer.newVec()
      .writeMap(Cbor.len(3))
      .writeUnsignedInteger(2)
      .writeBytes(Uint8Array.from([1]))
      .writeUnsignedInteger(4)
      .writeArray(Cbor.len(0))
      .writeUnsignedInteger(3)
      .writeArray(Cbor.len(1))
      .writeTag(9999)
      .writeMap(Cbor.len(0))
      .finalize()
    expectFailure(wrongTag, /tag 2201/)
  })

  it('rejects garbage without throwing', () => {
    expectFailure(Uint8Array.from([0xff, 0xff, 0xff]), /./)
  })
})

describe('formatKeyPath', () => {
  it('marks hardened components', () => {
    expect(formatKeyPath(shelleyPath)).toBe("m/1852'/1815'/0'/0/3")
  })

  it('renders an empty path as the root', () => {
    expect(formatKeyPath({components: []})).toBe('m')
  })
})

// ⚠️ Regression guard for a hole found by auditing Gero's implementation, which writes
// `hdPath: foundKey?.path || ''` when an input's address is not among its keys. Ours would have
// written `components: []` just as happily. A path-less UTxO asks a device to sign for an input while
// naming no key — at best refused on the device, at worst signed by whatever key it chooses.
describe('a derivation path with no components', () => {
  it('is refused by the writer, not passed to a device', () => {
    expect(() =>
      encodeCardanoSignRequest({
        signData: new Uint8Array([1, 2, 3]),
        utxos: [
          {
            transactionHash: new Uint8Array(32).fill(7),
            index: 0,
            amount: '1000000',
            keyPath: {components: []},
            address: 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
          },
        ],
        extraSigners: [],
      }),
    ).toThrow(/no components/)
  })
})

// The multisig case: a script transaction cannot be sent as a body, so the hash request is the only
// thing a device will answer. Its shape is asserted against the map keys published in
// `@keystonehq/bc-ur-registry-cardano@0.5.0`, not against our reading of a spec.
describe('encodeCardanoSignTxHashRequest', () => {
  const path = {
    components: [
      {index: 1854, hardened: true},
      {index: 1815, hardened: true},
      {index: 0, hardened: true},
    ],
  }
  const txHash = 'a'.repeat(64)
  const address = 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'

  it('writes txHash as text, paths under 3 and the address list under 5', () => {
    const cbor = encodeCardanoSignTxHashRequest({txHash, paths: [path], addressList: [address], origin: 'pnyx'})
    const cursor = cborReader(cbor)
    const seen = new Map<number, unknown>()
    readMapEntries(cursor, (key) => {
      switch (key) {
        case 2:
          // ⚠️ `text`, not `bytes` — the published encoder assigns a string, and 32 raw bytes here
          // produces a QR a device rejects in a way that looks like a firmware fault.
          seen.set(2, cursor.text())
          return true
        case 3: {
          const length = cursor.array()
          if (typeof length === 'string') throw new Error('paths must be definite')
          seen.set(3, length.definite)
          for (let i = 0; i < length.definite; i++) readKeypath(cursor)
          return true
        }
        case 4:
          seen.set(4, cursor.text())
          return true
        case 5: {
          const length = cursor.array()
          if (typeof length === 'string') throw new Error('addresses must be definite')
          seen.set(5, cursor.text())
          return true
        }
        default:
          return false
      }
    })
    expect(seen.get(2)).toBe(txHash)
    expect(seen.get(3)).toBe(1)
    expect(seen.get(4)).toBe('pnyx')
    expect(seen.get(5)).toBe(address)
  })

  // A body hash is blake2b-256. Anything else is the wrong digest or hex encoded twice, and a device
  // would sign it without complaint.
  it('refuses a hash that is not 32 bytes of hex', () => {
    for (const bad of ['', 'ab', `${txHash}ff`, 'z'.repeat(64)]) {
      expect(() => encodeCardanoSignTxHashRequest({txHash: bad, paths: [path], addressList: [address]})).toThrow(
        /32 bytes of hex/,
      )
    }
  })

  // ⚠️ The device pairs them positionally to show whose key it signs with, so a mismatch labels one
  // key with another's address — the same class as Eternl assigning keys by position.
  it('refuses when paths and addresses do not correspond', () => {
    expect(() => encodeCardanoSignTxHashRequest({txHash, paths: [path], addressList: []})).toThrow(/correspond/)
    expect(() => encodeCardanoSignTxHashRequest({txHash, paths: [], addressList: [address]})).toThrow(/no paths/)
  })
})
