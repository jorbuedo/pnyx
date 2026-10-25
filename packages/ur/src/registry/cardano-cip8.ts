/**
 * CIP-8 message signing over the Keystone registry.
 *
 * Tags and map keys were read off the published `@keystonehq/bc-ur-registry-cardano@0.5.0`
 * sources, the same way the 2201–2204 items were.
 *
 * ```
 * 2210 cardano-sign-cip8-data-request
 *   1 requestId(37) 2 signData(bytes) 3 derivationPath(304) 4 origin(text)
 *   5 signType(unused) 6 xpub(bytes) 7 hashPayload(bool) 8 addressBench32(text)
 *   9 addressFieldType(text: "ADDRESS" | "KEY_HASH")
 * 2211 cardano-sign-cip8-data-signature
 *   1 requestId(37) 2 signature(bytes) 3 publicKey(bytes)
 * ```
 *
 * Two details of the published source that a reimplementation gets wrong by guessing.
 * `addressFieldType` is a **text** string, not an enum ordinal. And key 5 (`signType`) appears in
 * the reference's key enum but is never written or read by its own encoder — so it is tolerated
 * here and never required.
 *
 * ⚠️ Sibling item 2205 (`cardano-sign-data-request`) is deliberately not implemented. It asks for a
 * bare signature over arbitrary bytes, and a Cardano vkey witness is a signature over a 32-byte
 * body hash — so answering it hands back a witness for a transaction nobody reviewed. CIP-8 is safe
 * for the reason 2205 is not: what gets signed is a COSE `Sig_structure` wrapping the payload, which
 * cannot collide with a body hash. See `docs/KEYSTONE_PLAN.md` §2.1.
 *
 * @module
 */

import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {cborReader, expectTag, readMapEntries} from '../cbor-read.js'
import {type CryptoKeypath, type DecodeResult, readKeypath, TAG_UUID, writeKeypath} from './cardano.js'

export const TAG_CARDANO_SIGN_CIP8_DATA_REQUEST = 2210
export const TAG_CARDANO_SIGN_CIP8_DATA_SIGNATURE = 2211
/** Tag 2205. Not implemented, and refused by name — see the module note. */
export const TAG_CARDANO_SIGN_DATA_REQUEST = 2205

export const UR_TYPE_SIGN_CIP8_DATA_REQUEST = 'cardano-sign-cip8-data-request'
export const UR_TYPE_SIGN_CIP8_DATA_SIGNATURE = 'cardano-sign-cip8-data-signature'
export const UR_TYPE_SIGN_DATA_REQUEST = 'cardano-sign-data-request'

/**
 * Which form of the signer's identity goes into the COSE `Sig_structure`'s address header.
 *
 * `ADDRESS` embeds the full address, which is what a dApp proving address control expects.
 * `KEY_HASH` embeds the bare credential hash, the CIP-95 DRep form. The distinction changes the
 * bytes that get signed, so it is never inferred.
 */
export type MessageAddressFieldType = 'ADDRESS' | 'KEY_HASH'

export type CardanoSignCip8DataRequest = {
  readonly requestId?: Uint8Array
  /** The message to sign, raw. Wrapped in a COSE `Sig_structure` before any key touches it. */
  readonly signData: Uint8Array
  /** ⚠️ The counterparty's claim about which key to use. Display-only — see the note below. */
  readonly derivationPath: CryptoKeypath
  /** ⚠️ Attacker-authored. Never render it as an established fact. */
  readonly origin?: string
  /** The account xpub the sender believes that path belongs to. Checkable, and must be checked. */
  readonly xpub: Uint8Array
  /** Whether the payload is blake2b-224 hashed before wrapping (CIP-8 allows both). */
  readonly hashPayload: boolean
  /** Present in `ADDRESS` mode. Absent in `KEY_HASH` mode, where there is no address to state. */
  readonly addressBech32?: string
  readonly addressFieldType: MessageAddressFieldType
}

export type CardanoSignCip8DataSignature = {
  readonly requestId?: Uint8Array
  /** The COSE_Sign1, raw. */
  readonly signature: Uint8Array
  /** The COSE_Key, raw. */
  readonly publicKey: Uint8Array
}

// ── encoding ──────────────────────────────────────────────────────────────────

/** Encode the reply. This is the payload Pnyx presents back as a QR. */
export const encodeCardanoSignCip8DataSignature = (signature: CardanoSignCip8DataSignature): Uint8Array => {
  const entries = 2 + (signature.requestId === undefined ? 0 : 1)
  const serializer = Cbor.Serializer.newVec().writeMap(Cbor.len(entries))
  if (signature.requestId !== undefined) {
    serializer.writeUnsignedInteger(1).writeTag(TAG_UUID).writeBytes(signature.requestId)
  }
  serializer.writeUnsignedInteger(2).writeBytes(signature.signature)
  serializer.writeUnsignedInteger(3).writeBytes(signature.publicKey)
  return serializer.finalize()
}

/**
 * Encode a request. Item 29 never sends one — this exists so tests and the playground can build
 * fixtures from the same field set the decoder reads, rather than from hand-rolled bytes that
 * would only ever agree with themselves.
 */
export const encodeCardanoSignCip8DataRequest = (request: CardanoSignCip8DataRequest): Uint8Array => {
  const entries =
    5 +
    (request.requestId === undefined ? 0 : 1) +
    (request.origin === undefined ? 0 : 1) +
    (request.addressBech32 === undefined ? 0 : 1)
  const serializer = Cbor.Serializer.newVec().writeMap(Cbor.len(entries))
  if (request.requestId !== undefined) {
    serializer.writeUnsignedInteger(1).writeTag(TAG_UUID).writeBytes(request.requestId)
  }
  serializer.writeUnsignedInteger(2).writeBytes(request.signData)
  serializer.writeUnsignedInteger(3)
  writeKeypath(serializer, request.derivationPath)
  if (request.origin !== undefined) serializer.writeUnsignedInteger(4).writeText(request.origin)
  serializer.writeUnsignedInteger(6).writeBytes(request.xpub)
  serializer.writeUnsignedInteger(7).writeSpecial(Cbor.Special.Bool, request.hashPayload)
  if (request.addressBech32 !== undefined) serializer.writeUnsignedInteger(8).writeText(request.addressBech32)
  serializer.writeUnsignedInteger(9).writeText(request.addressFieldType)
  return serializer.finalize()
}

// ── decoding ──────────────────────────────────────────────────────────────────

/** An ed25519 account xpub: 32-byte public key ‖ 32-byte chain code. */
const XPUB_BYTES = 64

/**
 * Parse a `cardano-sign-cip8-data-request`.
 *
 * ⚠️ **This decides nothing about whether the request is safe to answer.** In particular
 * `derivationPath` is the sender's claim about which of our keys to use, and a signer that obeys it
 * signs with whatever key it is told to. The rule mirrors the one already in force for transactions:
 * resolve the key from the *address* against our own registry and treat the request's path as
 * display-only; in `KEY_HASH` mode, where there is no address, check the request's `xpub` against
 * the key we derive ourselves and refuse when it does not match.
 */
export const decodeCardanoSignCip8DataRequest = (cbor: Uint8Array): DecodeResult<CardanoSignCip8DataRequest> => {
  try {
    const cursor = cborReader(cbor)
    let requestId: Uint8Array | undefined
    let signData: Uint8Array | undefined
    let derivationPath: CryptoKeypath | undefined
    let origin: string | undefined
    let xpub: Uint8Array | undefined
    let hashPayload: boolean | undefined
    let addressBech32: string | undefined
    let addressFieldType: string | undefined

    readMapEntries(cursor, (key) => {
      switch (key) {
        case 1:
          expectTag(cursor, TAG_UUID, 'uuid')
          requestId = cursor.bytes()
          return true
        case 2:
          signData = cursor.bytes()
          return true
        case 3:
          derivationPath = readKeypath(cursor)
          return true
        case 4:
          origin = cursor.text()
          return true
        case 6:
          xpub = cursor.bytes()
          return true
        case 7:
          hashPayload = cursor.bool()
          return true
        case 8:
          addressBech32 = cursor.text()
          return true
        case 9:
          addressFieldType = cursor.text()
          return true
        // Key 5 (`signType`) is named in the reference's key enum but never written by its own
        // encoder. Skipping rather than rejecting keeps a device that does emit it readable.
        default:
          return false
      }
    })

    if (signData === undefined) throw new Error('cardano-sign-cip8-data-request: missing signData')
    if (derivationPath === undefined) throw new Error('cardano-sign-cip8-data-request: missing derivationPath')
    if (xpub === undefined) throw new Error('cardano-sign-cip8-data-request: missing xpub')
    if (hashPayload === undefined) throw new Error('cardano-sign-cip8-data-request: missing hashPayload')
    if (addressFieldType === undefined) {
      throw new Error('cardano-sign-cip8-data-request: missing addressFieldType')
    }
    if (addressFieldType !== 'ADDRESS' && addressFieldType !== 'KEY_HASH') {
      // Not a tolerable unknown: it selects what goes into the signed Sig_structure, so guessing
      // would mean signing bytes the sender did not ask for.
      throw new Error(`cardano-sign-cip8-data-request: unknown addressFieldType ${JSON.stringify(addressFieldType)}`)
    }
    if (addressFieldType === 'ADDRESS' && addressBech32 === undefined) {
      throw new Error('cardano-sign-cip8-data-request: ADDRESS mode with no address')
    }
    if (xpub.length !== XPUB_BYTES) {
      throw new Error(`cardano-sign-cip8-data-request: an xpub is ${XPUB_BYTES} bytes, got ${xpub.length}`)
    }
    if (signData.length === 0) throw new Error('cardano-sign-cip8-data-request: nothing to sign')

    return {
      ok: true,
      value: {
        ...(requestId === undefined ? {} : {requestId}),
        signData,
        derivationPath,
        ...(origin === undefined ? {} : {origin}),
        xpub,
        hashPayload,
        ...(addressBech32 === undefined ? {} : {addressBech32}),
        addressFieldType,
      },
    }
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)}
  }
}

/** Parse a `cardano-sign-cip8-data-signature`. Only item 28 reads one; kept as the decoder half. */
export const decodeCardanoSignCip8DataSignature = (cbor: Uint8Array): DecodeResult<CardanoSignCip8DataSignature> => {
  try {
    const cursor = cborReader(cbor)
    let requestId: Uint8Array | undefined
    let signature: Uint8Array | undefined
    let publicKey: Uint8Array | undefined

    readMapEntries(cursor, (key) => {
      switch (key) {
        case 1:
          expectTag(cursor, TAG_UUID, 'uuid')
          requestId = cursor.bytes()
          return true
        case 2:
          signature = cursor.bytes()
          return true
        case 3:
          publicKey = cursor.bytes()
          return true
        default:
          return false
      }
    })

    if (signature === undefined) throw new Error('cardano-sign-cip8-data-signature: missing signature')
    if (publicKey === undefined) throw new Error('cardano-sign-cip8-data-signature: missing publicKey')
    return {ok: true, value: {...(requestId === undefined ? {} : {requestId}), signature, publicKey}}
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)}
  }
}
