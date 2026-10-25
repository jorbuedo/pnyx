/**
 * `crypto-hdkey` (303) and `crypto-multi-accounts` (1103) — the account-export side.
 *
 * Both directions. Item 29 makes Pnyx the *signer*, publishing its accounts; item 28 makes Pnyx the
 * *driver* of a Keystone, reading the device's export to learn which keys it holds. Same registry
 * items, opposite roles — so one module, two functions, and no chance of the two readings drifting.
 *
 * ```
 *  303 crypto-hdkey  1 isMaster 2 isPrivate 3 keyData 4 chainCode 5 useInfo(305)
 *                    6 origin(304) 7 children(304) 8 parentFingerprint 9 name 10 note
 *  305 crypto-coin-info  1 type(SLIP-44) 2 network(0 mainnet / 1 testnet)
 * 1103 crypto-multi-accounts  1 masterFingerprint 2 keys[303] 3 device 4 deviceId 5 version
 * ```
 *
 * `isMaster` and `isPrivate` are omitted rather than written false: BCR-2020-007 gives both a
 * CDDL default of false, so omitting them is the canonical encoding.
 *
 * @module
 */

import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {cborReader, expectTag, readMapEntries} from '../cbor-read.js'
import {type CryptoKeypath, type DecodeResult, readKeypath, TAG_CRYPTO_KEYPATH} from './cardano.js'

export const TAG_CRYPTO_HDKEY = 303
export const TAG_CRYPTO_COIN_INFO = 305
export const TAG_CRYPTO_MULTI_ACCOUNTS = 1103
export const UR_TYPE_MULTI_ACCOUNTS = 'crypto-multi-accounts'

/** SLIP-44 coin type for Cardano — the `type` a `crypto-coin-info` carries. */
export const COIN_TYPE_CARDANO = 1815

/**
 * `crypto-coin-info` (305) — which chain a key is for, and on which network.
 *
 * ⚠️ **`network` is BCR's numbering, not Cardano's, and they are inverted.** BCR-2020-007 defines
 * `mainnet = 0` and `testnet = 1`; Cardano's own network id is `mainnet = 1`, `testnet = 0`.
 * Passing a Cardano network id straight through would export every mainnet account as testnet and
 * vice versa — see {@link bcrNetwork}.
 */
export type CoinInfo = {
  /** SLIP-44 coin type. Defaults to Bitcoin (0) in the spec, so Cardano must state it. */
  readonly type: number
  /** BCR numbering: 0 mainnet, 1 testnet. */
  readonly network: number
}

/** Cardano's network id (0 testnet / 1 mainnet) in BCR's inverted numbering. */
export const bcrNetwork = (cardanoNetworkId: number): number => (cardanoNetworkId === 1 ? 0 : 1)

/** One exported account key. */
export type ExportedHdKey = {
  /** The public key bytes. Length is chain-dependent — 33 for secp256k1, 32 for ed25519. */
  readonly keyData: Uint8Array
  readonly chainCode: Uint8Array
  /** Where this key sits, which is what tells a companion wallet what it is looking at. */
  readonly origin: CryptoKeypath
  /**
   * Which chain and network this key is for. The only place an export can say so: a reader
   * deriving addresses from the xpub otherwise has to guess between `addr1…` and `addr_test1…`.
   */
  readonly useInfo?: CoinInfo
  readonly parentFingerprint?: number
  /** Shown by the companion wallet in its account list. */
  readonly name?: string
}

export type MultiAccounts = {
  /** The master key's fingerprint (`xfp`), shared by every key in `keys`. */
  readonly masterFingerprint: number
  readonly keys: readonly ExportedHdKey[]
  readonly device?: string
  readonly deviceId?: string
  readonly version?: string
}

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

/**
 * `crypto-coin-info`. Both fields are written even when they equal the CDDL default, unlike
 * `isMaster` / `isPrivate` above: the reason this map exists in our export is to *state* the
 * network, and communicating it by omission defeats that.
 */
const writeCoinInfo = (serializer: InstanceType<typeof Cbor.Serializer>, info: CoinInfo): void => {
  serializer
    .writeTag(TAG_CRYPTO_COIN_INFO)
    .writeMap(Cbor.len(2))
    .writeUnsignedInteger(1)
    .writeUnsignedInteger(info.type)
    .writeUnsignedInteger(2)
    .writeUnsignedInteger(info.network)
}

const writeHdKey = (serializer: InstanceType<typeof Cbor.Serializer>, key: ExportedHdKey): void => {
  const entries =
    3 +
    (key.useInfo === undefined ? 0 : 1) +
    (key.parentFingerprint === undefined ? 0 : 1) +
    (key.name === undefined ? 0 : 1)
  serializer
    .writeTag(TAG_CRYPTO_HDKEY)
    .writeMap(Cbor.len(entries))
    .writeUnsignedInteger(3)
    .writeBytes(key.keyData)
    .writeUnsignedInteger(4)
    .writeBytes(key.chainCode)
  if (key.useInfo !== undefined) {
    serializer.writeUnsignedInteger(5)
    writeCoinInfo(serializer, key.useInfo)
  }
  serializer.writeUnsignedInteger(6)
  writeKeypath(serializer, key.origin)
  if (key.parentFingerprint !== undefined) {
    serializer.writeUnsignedInteger(8).writeUnsignedInteger(key.parentFingerprint)
  }
  if (key.name !== undefined) serializer.writeUnsignedInteger(9).writeText(key.name)
}

/** Encode the payload a companion wallet scans to start watching our accounts. */
export const encodeMultiAccounts = (accounts: MultiAccounts): Uint8Array => {
  if (accounts.keys.length === 0) throw new Error('crypto-multi-accounts: nothing to export')
  const entries =
    2 +
    (accounts.device === undefined ? 0 : 1) +
    (accounts.deviceId === undefined ? 0 : 1) +
    (accounts.version === undefined ? 0 : 1)

  const serializer = Cbor.Serializer.newVec()
    .writeMap(Cbor.len(entries))
    .writeUnsignedInteger(1)
    .writeUnsignedInteger(accounts.masterFingerprint)
    .writeUnsignedInteger(2)
    .writeArray(Cbor.len(accounts.keys.length))
  for (const key of accounts.keys) writeHdKey(serializer, key)
  if (accounts.device !== undefined) serializer.writeUnsignedInteger(3).writeText(accounts.device)
  if (accounts.deviceId !== undefined) serializer.writeUnsignedInteger(4).writeText(accounts.deviceId)
  if (accounts.version !== undefined) serializer.writeUnsignedInteger(5).writeText(accounts.version)
  return serializer.finalize()
}

/** A cap on how many accounts one export may carry, so a hostile frame cannot fan out unboundedly. */
const MAX_KEYS = 256

const readCoinInfo = (cursor: ReturnType<typeof cborReader>): CoinInfo => {
  expectTag(cursor, TAG_CRYPTO_COIN_INFO, 'crypto-coin-info')
  // Both fields have CDDL defaults — type 0 (Bitcoin) and network 0 — so an absent one is not an
  // error. Defaulting `type` to Bitcoin would be wrong for us to *write*, and is still what a reader
  // must assume when a sender omits it.
  let type = 0
  let network = 0
  readMapEntries(cursor, (key) => {
    switch (key) {
      case 1:
        type = Number(cursor.unsignedInteger())
        return true
      case 2:
        network = Number(cursor.unsignedInteger())
        return true
      default:
        return false
    }
  })
  return {type, network}
}

const readHdKey = (cursor: ReturnType<typeof cborReader>): ExportedHdKey => {
  expectTag(cursor, TAG_CRYPTO_HDKEY, 'crypto-hdkey')
  let keyData: Uint8Array | undefined
  let chainCode: Uint8Array | undefined
  let origin: CryptoKeypath | undefined
  let useInfo: CoinInfo | undefined
  let parentFingerprint: number | undefined
  let name: string | undefined

  readMapEntries(cursor, (key) => {
    switch (key) {
      case 3:
        keyData = cursor.bytes()
        return true
      case 4:
        chainCode = cursor.bytes()
        return true
      case 5:
        useInfo = readCoinInfo(cursor)
        return true
      case 6:
        origin = readKeypath(cursor)
        return true
      case 8:
        parentFingerprint = Number(cursor.unsignedInteger())
        return true
      case 9:
        name = cursor.text()
        return true
      default:
        // Includes 1 `isMaster`, 2 `isPrivate`, 7 `children` and 10 `note`: skipped rather than
        // refused, because a device sending a field this reader does not need is still an export we
        // can act on.
        return false
    }
  })

  if (keyData === undefined) throw new Error('crypto-hdkey: no key data')
  if (chainCode === undefined) throw new Error('crypto-hdkey: no chain code')
  // ⚠️ Required by *us*, not by the spec, and the reason is what an export is for: without the path
  // there is no way to know whether a key is the payment account, the stake account or a CIP-1854
  // multisig one, and guessing assigns a device's key to the wrong role.
  if (origin === undefined) throw new Error('crypto-hdkey: no origin path')

  return {
    keyData,
    chainCode,
    origin,
    ...(useInfo === undefined ? {} : {useInfo}),
    ...(parentFingerprint === undefined ? {} : {parentFingerprint}),
    ...(name === undefined ? {} : {name}),
  }
}

/**
 * Read a device's account export — the payload that says which keys a Keystone holds.
 *
 * ⚠️ **`useInfo.network` is BCR's numbering and is returned raw.** BCR-2020-007 says
 * `0 = mainnet, 1 = testnet`; Cardano's own id is the opposite. {@link bcrNetwork} converts on the
 * way out and the inverse is *not* applied here, deliberately: our reading of the direction has only
 * ever been exercised on preprod, where a consistently inverted reading looks identical to a correct
 * one. A caller that acts on the network must decide knowing that.
 *
 * ⚠️ **Every string in the result is attacker-authored** — `device`, `deviceId`, `version` and a
 * key's `name` come from whatever produced the QR. Render them as claims, never as provenance, and
 * never let one pick a derivation path.
 */
export const decodeMultiAccounts = (bytes: Uint8Array): DecodeResult<MultiAccounts> => {
  try {
    const cursor = cborReader(bytes)
    let masterFingerprint: number | undefined
    let keys: ExportedHdKey[] | undefined
    let device: string | undefined
    let deviceId: string | undefined
    let version: string | undefined

    readMapEntries(cursor, (key) => {
      switch (key) {
        case 1:
          masterFingerprint = Number(cursor.unsignedInteger())
          return true
        case 2: {
          const length = cursor.array()
          if (typeof length === 'string') throw new Error('crypto-multi-accounts: keys must be a definite array')
          if (length.definite > MAX_KEYS) throw new Error('crypto-multi-accounts: too many keys')
          const read: ExportedHdKey[] = []
          for (let i = 0; i < length.definite; i++) read.push(readHdKey(cursor))
          keys = read
          return true
        }
        case 3:
          device = cursor.text()
          return true
        case 4:
          deviceId = cursor.text()
          return true
        case 5:
          version = cursor.text()
          return true
        default:
          return false
      }
    })

    if (masterFingerprint === undefined) throw new Error('crypto-multi-accounts: no master fingerprint')
    if (keys === undefined || keys.length === 0) throw new Error('crypto-multi-accounts: no keys')

    return {
      ok: true,
      value: {
        masterFingerprint,
        keys,
        ...(device === undefined ? {} : {device}),
        ...(deviceId === undefined ? {} : {deviceId}),
        ...(version === undefined ? {} : {version}),
      },
    }
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)}
  }
}
