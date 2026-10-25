/**
 * CIP-4 wallet checksum.
 *
 * Produces a visual wallet plate identifier from an account public key hex string.
 * Compatible with the CIP-4 reference implementation's walletChecksum:
 * - ImagePart (seed): BLAKE2B-512 of the hex string (as UTF-8), personalized with "wallets checksum"
 * - TextPart (plate): FNV-1a-32 of the seed → "XXXX-1234" using 16-char alphabet
 *
 * @module
 */

import {blake2b} from '@noble/hashes/blake2.js'

const PERSONALIZATION = new TextEncoder().encode('wallets checksum')

/**
 * Wallet checksum result.
 */
export type WalletChecksum = {
  /** Human-readable plate text, e.g. "ABCD-1234" */
  readonly plate: string
  /** Hex string seed for identicon generation (128 hex chars = 64 bytes) */
  readonly seed: string
}

/**
 * 16-character alphabet matching the CIP-4 reference implementation.
 * Excludes visually ambiguous letters.
 */
const ALPHA = 'ABCDEJHKLNOPSTXZ'

/**
 * FNV-1a constants for 32-bit hash.
 */
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * Compute FNV-1a 32-bit hash of a string (character codes).
 * Matches fnv-plus fast1a32 used by the CIP-4 reference implementation.
 */
const fnv1a32 = (str: string): number => {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/**
 * Convert a 32-bit integer to 4 little-endian bytes.
 * Matches toBytesInt32 in the CIP-4 reference implementation.
 */
const toBytesInt32 = (int32: number): [number, number, number, number] => {
  const bytes: [number, number, number, number] = [0, 0, 0, 0]
  let v = int32
  for (let i = 0; i < 4; i++) {
    const b = v & 0xff
    bytes[i] = b
    v = (v - b) / 256
  }
  return bytes
}

/**
 * Convert 4 bytes to "XXXX-1234" plate format.
 * Uses the CIP-4 16-character alphabet and byte-splitting scheme.
 */
const textPartFromBytes = ([a, b, c, d]: [number, number, number, number]): string => {
  const letters = (x: number) => `${ALPHA[Math.floor(x / 16)]}${ALPHA[x % 16]}`
  const numbers = `${((c << 8) + d) % 10000}`.padStart(4, '0')
  return `${letters(a)}${letters(b)}-${numbers}`
}

/**
 * Compute a CIP-4 wallet checksum from an account public key hex string.
 *
 * The input is the account-level extended public key (64 bytes = 128 hex chars)
 * as produced by BIP32 derivation: 32-byte Ed25519 public key + 32-byte chain code.
 *
 * The checksum consists of:
 * - `seed`: BLAKE2B-512 of the hex string (UTF-8), personalized "wallets checksum" (128 hex chars)
 * - `plate`: FNV-1a-32 of the seed → "XXXX-1234" format
 *
 * @param publicKeyHex - The account public key as a lowercase hex string
 * @returns Wallet checksum with plate text and identicon seed
 *
 * @example
 * ```ts
 * const checksum = walletChecksum('a1b2c3d4...')
 * // { plate: 'XDLP-0123', seed: '...' }
 * ```
 */
export const walletChecksum = (publicKeyHex: string): WalletChecksum => {
  const clean = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex

  // Hash the hex string as UTF-8 bytes (not decoded binary) — matches CIP-4 spec
  const inputBytes = new TextEncoder().encode(clean)
  const hashBytes = blake2b(inputBytes, {dkLen: 64, personalization: PERSONALIZATION})
  const seed = bytesToHex(hashBytes)

  // TextPart: FNV-1a-32 of the seed string → toBytesInt32 → plate
  const plate = textPartFromBytes(toBytesInt32(fnv1a32(seed)))

  return {plate, seed}
}

/**
 * Encode bytes to hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}
