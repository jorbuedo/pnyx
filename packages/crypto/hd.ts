/**
 * Hierarchical-deterministic key derivation for address generation.
 *
 * - secp256k1 BIP-32 (Bitcoin, EVM) via @scure/bip32 `HDKey`.
 * - ed25519 SLIP-0010 (Solana) — hardened-only, implemented here since @scure
 *   has no ed25519 HD.
 *
 * All derive from a byte-identical BIP-39 seed so every chain shares one root
 * (see packages/wallet/account/seed.ts). Pure/synchronous; malformed paths throw
 * (callers wrap in Effect).
 *
 * @module
 */

import {hmac} from '@noble/hashes/hmac.js'
import {sha512} from '@noble/hashes/sha2.js'
import {utf8ToBytes} from '@noble/hashes/utils.js'
import {HDKey} from '@scure/bip32'

export {HDKey}

/** secp256k1 BIP-32 root for a seed. `.derive("m/44'/…")` walks the path. */
export const hdkeyFromSeed = (seed: Uint8Array): HDKey => HDKey.fromMasterSeed(seed)

/** secp256k1 private key (32 bytes) at a BIP-32 path. Throws if the node has no private key. */
export const secp256k1PrivateKeyAtPath = (seed: Uint8Array, path: string): Uint8Array => {
  const node = HDKey.fromMasterSeed(seed).derive(path)
  if (node.privateKey === null) throw new Error(`no private key at path ${path}`)
  return node.privateKey
}

const ED25519_SLIP10_KEY = utf8ToBytes('ed25519 seed')
const HARDENED_OFFSET = 0x80000000

/**
 * secp256k1 account-level extended **public** key (base58 `xpub…`) at
 * `accountPath` (e.g. `m/84'/0'/0'` for BTC, `m/44'/60'/0'` for EVM). Neutered —
 * carries only the 33-byte public key + 32-byte chain code, no private material,
 * so it is safe to persist and enables seedless receive/change discovery via
 * `secp256k1PublicChild`. Derive this once at import while the seed is available.
 */
export const secp256k1AccountXpub = (seed: Uint8Array, accountPath: string): string =>
  HDKey.fromMasterSeed(seed).derive(accountPath).publicExtendedKey

/**
 * Seedless (CKDpub) child compressed public key (33 bytes) from an account-level
 * xpub, at `change/index` (e.g. `0/5` = receive #5, `1/2` = change #2). BIP-32
 * public derivation supports NON-HARDENED indices only — a hardened index is
 * mathematically impossible without the private key and throws. Returns the
 * compressed pubkey the BTC (hash160) address builder consumes; EVM callers pass
 * it through `secp256k1Raw64FromCompressed`.
 *
 * @param accountXpub base58 `xpub…` from `secp256k1AccountXpub`.
 */
export const secp256k1PublicChild = (accountXpub: string, changeIndex: number, addressIndex: number): Uint8Array => {
  if (changeIndex >>> 0 >= HARDENED_OFFSET || addressIndex >>> 0 >= HARDENED_OFFSET) {
    throw new Error('secp256k1PublicChild: hardened indices cannot be derived from an xpub (public-only)')
  }
  const node = HDKey.fromExtendedKey(accountXpub).deriveChild(changeIndex).deriveChild(addressIndex)
  if (node.publicKey === null) throw new Error('secp256k1PublicChild: derived node has no public key')
  return node.publicKey
}

type Slip10Node = {readonly key: Uint8Array; readonly chainCode: Uint8Array}

const slip10Master = (seed: Uint8Array): Slip10Node => {
  const i = hmac(sha512, ED25519_SLIP10_KEY, seed)
  return {key: i.slice(0, 32), chainCode: i.slice(32)}
}

const slip10CKDPriv = ({key, chainCode}: Slip10Node, index: number): Slip10Node => {
  // ed25519 SLIP-0010 supports hardened derivation only.
  const data = new Uint8Array(37)
  data[0] = 0x00
  data.set(key, 1)
  const hardenedIndex = (index + HARDENED_OFFSET) >>> 0
  data[33] = (hardenedIndex >>> 24) & 0xff
  data[34] = (hardenedIndex >>> 16) & 0xff
  data[35] = (hardenedIndex >>> 8) & 0xff
  data[36] = hardenedIndex & 0xff
  const i = hmac(sha512, chainCode, data)
  return {key: i.slice(0, 32), chainCode: i.slice(32)}
}

/**
 * ed25519 SLIP-0010 private key (32 bytes) at an all-hardened path
 * (e.g. `m/44'/501'/0'/0'` for Solana). Every segment must be hardened.
 */
export const ed25519PrivateKeyAtPath = (seed: Uint8Array, path: string): Uint8Array => {
  const segments = path.replace(/^m\/?/, '').split('/').filter(Boolean)
  let node = slip10Master(seed)
  for (const seg of segments) {
    if (!seg.endsWith("'") && !seg.endsWith('h')) {
      throw new Error(`ed25519 SLIP-0010 requires hardened segments; got "${seg}" in "${path}"`)
    }
    const index = Number.parseInt(seg.slice(0, -1), 10)
    if (!Number.isInteger(index) || index < 0) throw new Error(`invalid path segment "${seg}" in "${path}"`)
    node = slip10CKDPriv(node, index)
  }
  return node.key
}
