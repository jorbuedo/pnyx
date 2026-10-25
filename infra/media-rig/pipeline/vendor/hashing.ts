/**
 * Hash primitives for address derivation. Pure, infallible (a hash never fails),
 * so these return bytes directly rather than Effect — consumers wrap in Effect
 * where a surrounding derivation can fail. Backed by audited @noble/hashes.
 *
 * @module
 */

import {blake2b as nobleBlake2b} from '@noble/hashes/blake2b'
import {ripemd160 as nobleRipemd160} from '@noble/hashes/ripemd160'
import {sha256 as nobleSha256} from '@noble/hashes/sha2'
import {keccak_256} from '@noble/hashes/sha3'

/** SHA-256. */
export const sha256 = (data: Uint8Array): Uint8Array => nobleSha256(data)

/** RIPEMD-160. */
export const ripemd160 = (data: Uint8Array): Uint8Array => nobleRipemd160(data)

/** Keccak-256 (Ethereum's hash — NOT SHA3-256; different padding). */
export const keccak256 = (data: Uint8Array): Uint8Array => keccak_256(data)

/** Bitcoin HASH160 = RIPEMD160(SHA256(x)) — the pubkey-hash for P2PKH / P2WPKH. */
export const hash160 = (data: Uint8Array): Uint8Array => nobleRipemd160(nobleSha256(data))

/**
 * BLAKE2b at an explicit digest length in BYTES — Cardano's hash family, which
 * uses several widths for different things (160-bit asset fingerprints, 224-bit
 * script/key hashes, 256-bit tx and datum hashes), so the width is never implied.
 */
export const blake2b = (data: Uint8Array, digestBytes: number): Uint8Array => nobleBlake2b(data, {dkLen: digestBytes})
