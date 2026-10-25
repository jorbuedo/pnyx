/**
 * `qr-hardware-call` — a companion wallet asking us for keys, rather than waiting for whatever we
 * choose to export.
 *
 * Discovered 2026-08-07 by decoding what the Eternl extension actually shows before it will scan
 * anything. It names the derivation paths it wants, so an export can answer exactly the question
 * asked instead of publishing a guess:
 *
 * ```
 * qr-hardware-call = { 1 callType 2 1301(call) 3 origin 4 version }
 * 1301 key-derivation-call   = { 1 schemas[1302] }
 * 1302 key-derivation-schema = { 1 keyPath(304) 2 curve 3 algo 4 chainType }
 * ```
 *
 * **Both directions.** We answer these as the signer (item 29) and *send* them as the driver of a
 * Keystone (item 28) — asking the device for the two accounts we can actually use rather than taking
 * whatever it volunteers.
 *
 * ⚠️ Read off **one observed sample** — Eternl asking for `m/1854'/1815'/0'` ("ADA_CIP_1854") and
 * `m/1852'/1815'/0'` ("ADA"), with curve and algo both `1`. Every field is therefore treated as
 * optional except the schema list, and unknown map keys are skipped rather than rejected: a
 * counterparty that sends a field this sample did not is a request we can still answer.
 *
 * @module
 */

import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {cborReader, expectTag, readMapEntries} from '../cbor-read.js'
import {type CryptoKeypath, type DecodeResult, readKeypath, TAG_CRYPTO_KEYPATH} from './cardano.js'

export const TAG_KEY_DERIVATION_CALL = 1301
export const TAG_KEY_DERIVATION_SCHEMA = 1302

export const UR_TYPE_QR_HARDWARE_CALL = 'qr-hardware-call'

/** A cap on how much one call may ask for, so a hostile frame cannot fan out unboundedly. */
const MAX_SCHEMAS = 256

/** One key the caller wants, and what it expects that key to be. */
export type KeyDerivationSchema = {
  readonly keyPath: CryptoKeypath
  /** Curve id. `1` in the observed Cardano sample; carried through rather than interpreted. */
  readonly curve?: number
  /** Derivation-algorithm id. `1` in the observed Cardano sample. */
  readonly algo?: number
  /** The caller's own label, e.g. `"ADA"` / `"ADA_CIP_1854"`. Attacker-authored — never render it as fact. */
  readonly chainType?: string
}

export type QrHardwareCall = {
  /** `0` in the observed sample. Absent means the caller did not say. */
  readonly callType?: number
  readonly schemas: readonly KeyDerivationSchema[]
  /** ⚠️ Attacker-authored (`"eternl"` in the sample). Never render it as established provenance. */
  readonly origin?: string
  readonly version?: number
}

const readSchema = (cursor: ReturnType<typeof cborReader>): KeyDerivationSchema => {
  expectTag(cursor, TAG_KEY_DERIVATION_SCHEMA, 'key-derivation-schema')
  let keyPath: CryptoKeypath | undefined
  let curve: number | undefined
  let algo: number | undefined
  let chainType: string | undefined

  readMapEntries(cursor, (key) => {
    switch (key) {
      case 1:
        keyPath = readKeypath(cursor)
        return true
      case 2:
        curve = Number(cursor.unsignedInteger())
        return true
      case 3:
        algo = Number(cursor.unsignedInteger())
        return true
      case 4:
        chainType = cursor.text()
        return true
      default:
        return false
    }
  })

  if (keyPath === undefined) throw new Error('key-derivation-schema: no key path')
  return {
    keyPath,
    ...(curve === undefined ? {} : {curve}),
    ...(algo === undefined ? {} : {algo}),
    ...(chainType === undefined ? {} : {chainType}),
  }
}

export const decodeQrHardwareCall = (cbor: Uint8Array): DecodeResult<QrHardwareCall> => {
  try {
    const cursor = cborReader(cbor)
    let callType: number | undefined
    let schemas: KeyDerivationSchema[] | undefined
    let origin: string | undefined
    let version: number | undefined

    readMapEntries(cursor, (key) => {
      switch (key) {
        case 1:
          callType = Number(cursor.unsignedInteger())
          return true
        case 2: {
          expectTag(cursor, TAG_KEY_DERIVATION_CALL, 'key-derivation-call')
          readMapEntries(cursor, (inner) => {
            if (inner !== 1) return false
            const length = cursor.array()
            if (typeof length === 'string') throw new Error('key-derivation-call: schemas must be a definite array')
            if (length.definite > MAX_SCHEMAS) {
              throw new Error(`key-derivation-call: ${length.definite} schemas is implausible`)
            }
            schemas = Array.from({length: length.definite}, () => readSchema(cursor))
            return true
          })
          return true
        }
        case 3:
          origin = cursor.text()
          return true
        case 4:
          version = Number(cursor.unsignedInteger())
          return true
        default:
          return false
      }
    })

    if (schemas === undefined) return {ok: false, error: 'qr-hardware-call: no key-derivation call'}
    if (schemas.length === 0) return {ok: false, error: 'qr-hardware-call: asks for no keys'}
    return {
      ok: true,
      value: {
        schemas,
        ...(callType === undefined ? {} : {callType}),
        ...(origin === undefined ? {} : {origin}),
        ...(version === undefined ? {} : {version}),
      },
    }
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)}
  }
}

/**
 * Curve and algorithm ids, as the one observed Cardano sample carried them.
 *
 * ⚠️ Both were `1` in Eternl's call and the SDK names them `ed25519` / `bip32ed25519`, which agrees.
 * Named here so a caller states an intent rather than a magic number, and so the day a second chain
 * needs different values it is one edit.
 */
export const CURVE_ED25519 = 1
export const ALGO_BIP32_ED25519 = 1

/** The chain labels Eternl used, which a Keystone is known to answer. */
export const CHAIN_TYPE_ADA = 'ADA'
export const CHAIN_TYPE_ADA_CIP_1854 = 'ADA_CIP_1854'

const writeKeypath = (serializer: InstanceType<typeof Cbor.Serializer>, keyPath: CryptoKeypath): void => {
  const entries = 1 + (keyPath.sourceFingerprint === undefined ? 0 : 1) + (keyPath.depth === undefined ? 0 : 1)
  serializer.writeTag(TAG_CRYPTO_KEYPATH).writeMap(Cbor.len(entries))
  serializer.writeUnsignedInteger(1).writeArray(Cbor.len(keyPath.components.length * 2))
  for (const component of keyPath.components) {
    serializer.writeUnsignedInteger(component.index).writeSpecial(Cbor.Special.Bool, component.hardened)
  }
  if (keyPath.sourceFingerprint !== undefined) {
    serializer.writeUnsignedInteger(2).writeUnsignedInteger(keyPath.sourceFingerprint)
  }
  if (keyPath.depth !== undefined) serializer.writeUnsignedInteger(3).writeUnsignedInteger(keyPath.depth)
}

const writeSchema = (serializer: InstanceType<typeof Cbor.Serializer>, schema: KeyDerivationSchema): void => {
  const entries =
    1 +
    (schema.curve === undefined ? 0 : 1) +
    (schema.algo === undefined ? 0 : 1) +
    (schema.chainType === undefined ? 0 : 1)
  serializer.writeTag(TAG_KEY_DERIVATION_SCHEMA).writeMap(Cbor.len(entries))
  serializer.writeUnsignedInteger(1)
  writeKeypath(serializer, schema.keyPath)
  if (schema.curve !== undefined) serializer.writeUnsignedInteger(2).writeUnsignedInteger(schema.curve)
  if (schema.algo !== undefined) serializer.writeUnsignedInteger(3).writeUnsignedInteger(schema.algo)
  if (schema.chainType !== undefined) serializer.writeUnsignedInteger(4).writeText(schema.chainType)
}

/**
 * Ask a device for specific keys.
 *
 * ⚠️ **This is what makes an export answerable rather than a guess.** Without it the device decides
 * what to publish and we match up whatever arrives; with it we name the two paths we can use, and a
 * response that does not contain them is a mismatch we can state instead of a wallet quietly created
 * around the wrong account.
 *
 * `origin` is our own name, and the mirror of the warning on the decode side: a *reader* must treat
 * it as attacker-authored, so we send something honest and never rely on a counterparty's.
 */
export const encodeQrHardwareCall = (call: QrHardwareCall): Uint8Array => {
  if (call.schemas.length === 0) throw new Error('qr-hardware-call: asks for no keys')
  if (call.schemas.length > MAX_SCHEMAS) throw new Error('qr-hardware-call: too many schemas')
  const entries =
    1 +
    (call.callType === undefined ? 0 : 1) +
    (call.origin === undefined ? 0 : 1) +
    (call.version === undefined ? 0 : 1)

  const serializer = Cbor.Serializer.newVec().writeMap(Cbor.len(entries))
  if (call.callType !== undefined) serializer.writeUnsignedInteger(1).writeUnsignedInteger(call.callType)
  serializer.writeUnsignedInteger(2).writeTag(TAG_KEY_DERIVATION_CALL).writeMap(Cbor.len(1))
  serializer.writeUnsignedInteger(1).writeArray(Cbor.len(call.schemas.length))
  for (const schema of call.schemas) writeSchema(serializer, schema)
  if (call.origin !== undefined) serializer.writeUnsignedInteger(3).writeText(call.origin)
  if (call.version !== undefined) serializer.writeUnsignedInteger(4).writeUnsignedInteger(call.version)
  return serializer.finalize()
}
