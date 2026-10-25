/**
 * Elliptic-curve public-key helpers for address derivation, backed by
 * @noble/curves. Pure functions — key math doesn't fail for well-formed inputs.
 *
 * secp256k1 covers Bitcoin + EVM; ed25519 covers Solana. The raw curve objects
 * are re-exported for callers that need signing or point ops.
 *
 * @module
 */

import {ed25519} from '@noble/curves/ed25519.js'
import {secp256k1} from '@noble/curves/secp256k1.js'

export {ed25519, secp256k1}

/** Compressed (33-byte) secp256k1 public key for a 32-byte private key. */
export const secp256k1PublicKeyCompressed = (privateKey: Uint8Array): Uint8Array =>
  secp256k1.getPublicKey(privateKey, true)

/**
 * Uncompressed secp256k1 public key **without** the `0x04` prefix (64 bytes:
 * X‖Y) — the form Ethereum keccak-hashes to produce an address.
 */
export const secp256k1PublicKeyRaw64 = (privateKey: Uint8Array): Uint8Array =>
  secp256k1.getPublicKey(privateKey, false).slice(1)

/**
 * Uncompressed secp256k1 public key **without** the `0x04` prefix (64 bytes:
 * X‖Y) from a 33-byte compressed public key — the EVM keccak-hash input when the
 * private key is unavailable (e.g. an xpub-derived public child).
 */
export const secp256k1Raw64FromCompressed = (compressed: Uint8Array): Uint8Array =>
  secp256k1.Point.fromBytes(compressed).toBytes(false).slice(1)

/** 32-byte ed25519 public key for a 32-byte private key (the Solana address bytes). */
export const ed25519PublicKey = (privateKey: Uint8Array): Uint8Array => ed25519.getPublicKey(privateKey)
