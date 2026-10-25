/**
 * The Keystone Cardano registry items.
 *
 * Tags and map keys were read off the published `@keystonehq/bc-ur-registry-cardano@0.5.0`
 * sources, not inferred — a wrong key number means a device rejects our request or we misread
 * theirs, and neither failure names its cause.
 *
 * ```
 * 2201 cardano-utxo      1 txHash(bytes) 2 index(uint) 3 amount(text) 4 keyPath(304) 5 address(text)
 * 2202 cardano-sign-request  1 requestId(37) 2 signData(bytes) 3 utxos[2201] 4 extraSigners[2204] 5 origin(text)
 * 2203 cardano-signature 1 requestId(37) 2 witnessSet(bytes)
 * 2204 cardano-cert-key  1 keyHash(bytes) 2 keyPath(304)
 *  304 crypto-keypath    1 components(array) 2 sourceFingerprint(uint32) 3 depth(uint)
 *   37 uuid
 * ```
 *
 * @module
 */

import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {type CborReader, cborReader, expectTag, readMapEntries} from '../cbor-read.js'

export const TAG_UUID = 37
export const TAG_CRYPTO_KEYPATH = 304
export const TAG_CARDANO_UTXO = 2201
export const TAG_CARDANO_SIGN_REQUEST = 2202
export const TAG_CARDANO_SIGNATURE = 2203
export const TAG_CARDANO_CERT_KEY = 2204
/**
 * Tag 2212.
 *
 * ⚠️ **Asymmetric on purpose: refused inbound, emitted outbound.** Being *asked* to sign a bare hash
 * is a witness for a transaction nobody reviewed — a Cardano vkey witness is a signature over a
 * 32-byte body hash, so answering one hands out a valid witness for unknown bytes. That refusal
 * stands and must not be relaxed.
 *
 * *Sending* one is a different question. We built the transaction, our own review screen shows it in
 * full before this is emitted, and `verifyWitnessSignatures` re-checks every returned witness against
 * the **reviewed** body hash — so a device that signs a different hash produces a witness we reject.
 * What the device's own screen can show is reduced; what the user sees is not.
 *
 * It exists because a script or multisig transaction cannot be sent as a body: see
 * {@link encodeCardanoSignTxHashRequest}.
 */
export const TAG_CARDANO_SIGN_TX_HASH_REQUEST = 2212

export const UR_TYPE_SIGN_REQUEST = 'cardano-sign-request'
export const UR_TYPE_SIGNATURE = 'cardano-signature'
export const UR_TYPE_SIGN_TX_HASH_REQUEST = 'cardano-sign-tx-hash-request'

/** A BIP-32 path component. `hardened` is carried separately, as the wire format does. */
export type PathComponent = {readonly index: number; readonly hardened: boolean}

export type CryptoKeypath = {
  readonly components: readonly PathComponent[]
  /** The master key's fingerprint (`xfp`), when the sender supplied one. */
  readonly sourceFingerprint?: number
  readonly depth?: number
}

export type CardanoUtxo = {
  readonly transactionHash: Uint8Array
  readonly index: number
  /** Lovelace, as text on the wire — it exceeds 2^53 in principle, so it is never a JS number. */
  readonly amount: string
  readonly keyPath: CryptoKeypath
  readonly address: string
}

export type CardanoCertKey = {
  readonly keyHash: Uint8Array
  readonly keyPath: CryptoKeypath
}

export type CardanoSignRequest = {
  readonly requestId?: Uint8Array
  /**
   * The **whole** unsigned transaction, raw CBOR — `[body, witness_set, is_valid,
   * auxiliary_data]`, not the body alone. Kept verbatim: slicing the body out is the consumer's
   * job, and re-encoding it would change the hash that gets signed.
   */
  readonly signData: Uint8Array
  readonly utxos: readonly CardanoUtxo[]
  readonly extraSigners: readonly CardanoCertKey[]
  /** ⚠️ Attacker-authored. Never render it as an established fact. */
  readonly origin?: string
}

export type CardanoSignature = {
  readonly requestId?: Uint8Array
  /** The witness set, raw CBOR. */
  readonly witnessSet: Uint8Array
}

// ── path rendering ────────────────────────────────────────────────────────────

/** `m/1852'/1815'/0'/0/0`. */
export const formatKeyPath = (keyPath: CryptoKeypath): string =>
  `m${keyPath.components.map((c) => `/${c.index}${c.hardened ? "'" : ''}`).join('')}`

// ── encoding ──────────────────────────────────────────────────────────────────

/**
 * Exported for the same reason {@link readKeypath} is: `crypto-keypath` (304) is a BCR primitive
 * that several Cardano items embed, and a second writer for it would be a second chance to get the
 * flat index/hardened pairing wrong.
 */
export const writeKeypath = (serializer: InstanceType<typeof Cbor.Serializer>, keyPath: CryptoKeypath): void => {
  // ⚠️ **A path-less entry is worse than a refused request.** It tells a device "sign for this input"
  // while naming no key, so the best case is a refusal on the device and the worst is a signature from
  // whatever key it picks. Gero's builder writes `hdPath: foundKey?.path || ''` when it cannot find the
  // address among its keys, which is exactly this hole with an empty string instead of an empty list —
  // and the same shape as the `addressHex: ''` trap in `cip8-request-review.ts`. Refuse at the writer,
  // because by the time it is bytes nobody can tell an unresolved key from a deliberate one.
  if (keyPath.components.length === 0) throw new Error('crypto-keypath: refusing to write a path with no components')
  const entries = 1 + (keyPath.sourceFingerprint === undefined ? 0 : 1) + (keyPath.depth === undefined ? 0 : 1)
  serializer.writeTag(TAG_CRYPTO_KEYPATH).writeMap(Cbor.len(entries))
  // Components are a flat array of alternating index / hardened pairs.
  serializer.writeUnsignedInteger(1).writeArray(Cbor.len(keyPath.components.length * 2))
  for (const component of keyPath.components) {
    serializer.writeUnsignedInteger(component.index).writeSpecial(Cbor.Special.Bool, component.hardened)
  }
  if (keyPath.sourceFingerprint !== undefined) {
    serializer.writeUnsignedInteger(2).writeUnsignedInteger(keyPath.sourceFingerprint)
  }
  if (keyPath.depth !== undefined) serializer.writeUnsignedInteger(3).writeUnsignedInteger(keyPath.depth)
}

const writeUtxo = (serializer: InstanceType<typeof Cbor.Serializer>, utxo: CardanoUtxo): void => {
  serializer
    .writeTag(TAG_CARDANO_UTXO)
    .writeMap(Cbor.len(5))
    .writeUnsignedInteger(1)
    .writeBytes(utxo.transactionHash)
    .writeUnsignedInteger(2)
    .writeUnsignedInteger(utxo.index)
    .writeUnsignedInteger(3)
    .writeText(utxo.amount)
    .writeUnsignedInteger(4)
  writeKeypath(serializer, utxo.keyPath)
  serializer.writeUnsignedInteger(5).writeText(utxo.address)
}

const writeCertKey = (serializer: InstanceType<typeof Cbor.Serializer>, certKey: CardanoCertKey): void => {
  serializer
    .writeTag(TAG_CARDANO_CERT_KEY)
    .writeMap(Cbor.len(2))
    .writeUnsignedInteger(1)
    .writeBytes(certKey.keyHash)
    .writeUnsignedInteger(2)
  writeKeypath(serializer, certKey.keyPath)
}

/** Encode a sign request — used to build fixtures and, later, item 28's outgoing requests. */
export const encodeCardanoSignRequest = (request: CardanoSignRequest): Uint8Array => {
  // signData, utxos and extraSigners are always written; requestId and origin are optional.
  const entries = 3 + (request.requestId === undefined ? 0 : 1) + (request.origin === undefined ? 0 : 1)
  const serializer = Cbor.Serializer.newVec().writeMap(Cbor.len(entries))
  if (request.requestId !== undefined) {
    serializer.writeUnsignedInteger(1).writeTag(TAG_UUID).writeBytes(request.requestId)
  }
  serializer.writeUnsignedInteger(2).writeBytes(request.signData)
  serializer.writeUnsignedInteger(3).writeArray(Cbor.len(request.utxos.length))
  for (const utxo of request.utxos) writeUtxo(serializer, utxo)
  serializer.writeUnsignedInteger(4).writeArray(Cbor.len(request.extraSigners.length))
  for (const certKey of request.extraSigners) writeCertKey(serializer, certKey)
  if (request.origin !== undefined) serializer.writeUnsignedInteger(5).writeText(request.origin)
  return serializer.finalize()
}

/** Encode the reply. This is the payload Pnyx presents back as a QR. */
export const encodeCardanoSignature = (signature: CardanoSignature): Uint8Array => {
  const entries = 1 + (signature.requestId === undefined ? 0 : 1)
  const serializer = Cbor.Serializer.newVec().writeMap(Cbor.len(entries))
  if (signature.requestId !== undefined) {
    serializer.writeUnsignedInteger(1).writeTag(TAG_UUID).writeBytes(signature.requestId)
  }
  serializer.writeUnsignedInteger(2).writeBytes(signature.witnessSet)
  return serializer.finalize()
}

// ── decoding ──────────────────────────────────────────────────────────────────

export type DecodeResult<T> = {readonly ok: true; readonly value: T} | {readonly ok: false; readonly error: string}

const MAX_UTXOS = 4096
const MAX_EXTRA_SIGNERS = 4096
const MAX_PATH_COMPONENTS = 64

/**
 * Exported because `crypto-keypath` (304) is a BCR primitive, not a Cardano one: `qr-hardware-call`
 * carries the same structure, and a second reader for it would be a second chance to get the
 * hardened-flag pairing wrong.
 */
export const readKeypath = (cursor: CborReader): CryptoKeypath => {
  expectTag(cursor, TAG_CRYPTO_KEYPATH, 'crypto-keypath')
  let components: PathComponent[] = []
  let sourceFingerprint: number | undefined
  let depth: number | undefined

  readMapEntries(cursor, (key) => {
    switch (key) {
      case 1: {
        const length = cursor.array()
        if (typeof length === 'string') throw new Error('crypto-keypath: components must be a definite array')
        if (length.definite % 2 !== 0) throw new Error('crypto-keypath: components must be index/hardened pairs')
        const count = length.definite / 2
        if (count > MAX_PATH_COMPONENTS) throw new Error(`crypto-keypath: ${count} components is implausible`)
        components = Array.from({length: count}, () => {
          // A wildcard is encoded as an empty array in the index slot. We are a signer, not a
          // descriptor parser — a path we cannot resolve to one key is not signable.
          if (cursor.cborType() === Cbor.CborType.Array) {
            throw new Error('crypto-keypath: wildcard components are not signable')
          }
          const index = Number(cursor.unsignedInteger())
          return {index, hardened: cursor.bool()}
        })
        return true
      }
      case 2:
        sourceFingerprint = Number(cursor.unsignedInteger())
        return true
      case 3:
        depth = Number(cursor.unsignedInteger())
        return true
      default:
        return false
    }
  })

  return {
    components,
    ...(sourceFingerprint === undefined ? {} : {sourceFingerprint}),
    ...(depth === undefined ? {} : {depth}),
  }
}

const readUtxo = (cursor: CborReader): CardanoUtxo => {
  expectTag(cursor, TAG_CARDANO_UTXO, 'cardano-utxo')
  let transactionHash: Uint8Array | undefined
  let index: number | undefined
  let amount: string | undefined
  let keyPath: CryptoKeypath | undefined
  let address: string | undefined

  readMapEntries(cursor, (key) => {
    switch (key) {
      case 1:
        transactionHash = cursor.bytes()
        return true
      case 2:
        index = Number(cursor.unsignedInteger())
        return true
      case 3:
        amount = cursor.text()
        return true
      case 4:
        keyPath = readKeypath(cursor)
        return true
      case 5:
        address = cursor.text()
        return true
      default:
        return false
    }
  })

  if (transactionHash === undefined || index === undefined || amount === undefined) {
    throw new Error('cardano-utxo: missing txHash, index or amount')
  }
  if (keyPath === undefined || address === undefined) throw new Error('cardano-utxo: missing keyPath or address')
  if (transactionHash.length !== 32) {
    throw new Error(`cardano-utxo: a transaction hash is 32 bytes, got ${transactionHash.length}`)
  }
  if (!/^\d+$/.test(amount)) throw new Error(`cardano-utxo: amount ${JSON.stringify(amount)} is not a whole number`)
  return {transactionHash, index, amount, keyPath, address}
}

const readCertKey = (cursor: CborReader): CardanoCertKey => {
  expectTag(cursor, TAG_CARDANO_CERT_KEY, 'cardano-cert-key')
  let keyHash: Uint8Array | undefined
  let keyPath: CryptoKeypath | undefined
  readMapEntries(cursor, (key) => {
    switch (key) {
      case 1:
        keyHash = cursor.bytes()
        return true
      case 2:
        keyPath = readKeypath(cursor)
        return true
      default:
        return false
    }
  })
  if (keyHash === undefined || keyPath === undefined) throw new Error('cardano-cert-key: missing keyHash or keyPath')
  if (keyHash.length !== 28) throw new Error(`cardano-cert-key: a key hash is 28 bytes, got ${keyHash.length}`)
  return {keyHash, keyPath}
}

/**
 * Parse a `cardano-sign-request` payload.
 *
 * Everything here arrives from a scanned code, so counts are capped and shapes are checked. What
 * this deliberately does *not* do is decide whether the request is safe to sign — the UTxO values
 * it carries are the counterparty's claims, and checking them against our own synced state is a
 * separate step that the review surface must not skip.
 */
export const decodeCardanoSignRequest = (cbor: Uint8Array): DecodeResult<CardanoSignRequest> => {
  try {
    const cursor = cborReader(cbor)
    let requestId: Uint8Array | undefined
    let signData: Uint8Array | undefined
    let utxos: CardanoUtxo[] = []
    let extraSigners: CardanoCertKey[] = []
    let origin: string | undefined

    readMapEntries(cursor, (key) => {
      switch (key) {
        case 1:
          expectTag(cursor, TAG_UUID, 'uuid')
          requestId = cursor.bytes()
          return true
        case 2:
          signData = cursor.bytes()
          return true
        case 3: {
          const length = cursor.array()
          if (typeof length === 'string') throw new Error('cardano-sign-request: utxos must be a definite array')
          if (length.definite > MAX_UTXOS) throw new Error(`cardano-sign-request: ${length.definite} utxos`)
          utxos = Array.from({length: length.definite}, () => readUtxo(cursor))
          return true
        }
        case 4: {
          const length = cursor.array()
          if (typeof length === 'string') {
            throw new Error('cardano-sign-request: extraSigners must be a definite array')
          }
          if (length.definite > MAX_EXTRA_SIGNERS) {
            throw new Error(`cardano-sign-request: ${length.definite} extra signers`)
          }
          extraSigners = Array.from({length: length.definite}, () => readCertKey(cursor))
          return true
        }
        case 5:
          origin = cursor.text()
          return true
        default:
          return false
      }
    })

    if (signData === undefined) return {ok: false, error: 'cardano-sign-request: no signData'}
    if (signData.length === 0) return {ok: false, error: 'cardano-sign-request: signData is empty'}
    return {
      ok: true,
      value: {
        ...(requestId === undefined ? {} : {requestId}),
        signData,
        utxos,
        extraSigners,
        ...(origin === undefined ? {} : {origin}),
      },
    }
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)}
  }
}

export const decodeCardanoSignature = (cbor: Uint8Array): DecodeResult<CardanoSignature> => {
  try {
    const cursor = cborReader(cbor)
    let requestId: Uint8Array | undefined
    let witnessSet: Uint8Array | undefined
    readMapEntries(cursor, (key) => {
      switch (key) {
        case 1:
          expectTag(cursor, TAG_UUID, 'uuid')
          requestId = cursor.bytes()
          return true
        case 2:
          witnessSet = cursor.bytes()
          return true
        default:
          return false
      }
    })
    if (witnessSet === undefined) return {ok: false, error: 'cardano-signature: no witness set'}
    return {ok: true, value: {...(requestId === undefined ? {} : {requestId}), witnessSet}}
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)}
  }
}

/**
 * `cardano-sign-tx-hash-request` (2212) — the only request a Keystone will answer for a transaction
 * it cannot parse as a plain body.
 *
 * ```
 * 2212 = { 1 requestId(37) 2 txHash(text) 3 paths[304] 4 origin 5 address_list[text] }
 * ```
 *
 * ⚠️ **`txHash` is text, not bytes** — a hex string on the wire. Read off
 * `@keystonehq/bc-ur-registry-cardano@0.5.0`'s own encoder, where `map[Keys.txHash] = this.txHash`
 * assigns a `string`. Writing 32 raw bytes here produces a QR a device rejects, and the failure would
 * look like a firmware problem rather than an encoding one.
 *
 * ⚠️ **`address_list` is bech32 text**, not raw address bytes — the same trap in the other direction
 * from `CardanoUtxo.address`.
 */
export type CardanoSignTxHashRequest = {
  /** Hex, without a `0x` prefix. */
  readonly txHash: string
  /** Every path whose key the device must sign with. */
  readonly paths: readonly CryptoKeypath[]
  /** Bech32 addresses, in the same order as `paths`, for the device to display. */
  readonly addressList: readonly string[]
  readonly requestId?: Uint8Array
  readonly origin?: string
}

/**
 * Ask a device to sign a transaction *hash*, for the script and multisig cases a body cannot express.
 *
 * ⚠️ **Only reach for this when a body request is impossible.** `cardano-sign-request` (2202) lets the
 * device show its holder the transaction; this does not. The protections that make it acceptable live
 * outside this codec — our own review screen before it is emitted, and `verifyWitnessSignatures`
 * against the reviewed body hash after — so a caller that skips either has removed the only thing
 * standing between a user and a blind signature.
 */
export const encodeCardanoSignTxHashRequest = (request: CardanoSignTxHashRequest): Uint8Array => {
  if (!/^[0-9a-f]{64}$/i.test(request.txHash)) {
    // A body hash is blake2b-256, so 32 bytes. Anything else is either the wrong digest or bytes that
    // were hex-encoded twice, and both would be signed without complaint.
    throw new Error('cardano-sign-tx-hash-request: txHash must be 32 bytes of hex')
  }
  if (request.paths.length === 0) throw new Error('cardano-sign-tx-hash-request: no paths to sign with')
  if (request.addressList.length !== request.paths.length) {
    // The device pairs them positionally to show whose key it is signing with. A mismatch would label
    // one key with another's address — the same class as Eternl assigning keys by position.
    throw new Error('cardano-sign-tx-hash-request: paths and addresses must correspond')
  }

  const entries = 3 + (request.requestId === undefined ? 0 : 1) + (request.origin === undefined ? 0 : 1)
  const serializer = Cbor.Serializer.newVec().writeMap(Cbor.len(entries))
  if (request.requestId !== undefined) {
    serializer.writeUnsignedInteger(1).writeTag(TAG_UUID).writeBytes(request.requestId)
  }
  serializer.writeUnsignedInteger(2).writeText(request.txHash)
  serializer.writeUnsignedInteger(3).writeArray(Cbor.len(request.paths.length))
  for (const path of request.paths) writeKeypath(serializer, path)
  if (request.origin !== undefined) serializer.writeUnsignedInteger(4).writeText(request.origin)
  serializer.writeUnsignedInteger(5).writeArray(Cbor.len(request.addressList.length))
  for (const address of request.addressList) serializer.writeText(address)
  return serializer.finalize()
}
