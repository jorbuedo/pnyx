/**
 * Shared utilities for hardware wallet modules.
 *
 * Consolidates hex/bytes conversion, derivation path utilities,
 * and error pattern matching used across Ledger and Trezor code.
 *
 * @module
 */

export {formatDerivationPath, HARDENED, parseDerivationPath, requireDerivationPath} from './derivation/shared'

/**
 * Converts a hex string to a Uint8Array.
 * Handles optional '0x' prefix.
 */
export const hexToBytes = (hex: string): Uint8Array => {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(cleanHex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Converts a Uint8Array to a lowercase hex string.
 */
export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/**
 * Checks if an error message matches any of the given patterns (case-insensitive).
 */
export const matchesPattern = (error: unknown, patterns: readonly string[]): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  const lowerMessage = message.toLowerCase()
  return patterns.some((pattern) => lowerMessage.includes(pattern.toLowerCase()))
}

/**
 * Compress an uncompressed secp256k1 public key (65 bytes) to compressed form (33 bytes).
 *
 * If the key is already compressed (33 bytes starting with 0x02 or 0x03), returns it unchanged.
 * Uncompressed keys start with 0x04 followed by 32-byte x and 32-byte y coordinates.
 * The compressed form uses 0x02 (y even) or 0x03 (y odd) prefix + x coordinate.
 */
export const compressSecp256k1PublicKey = (publicKey: Uint8Array): Uint8Array => {
  if (publicKey.length === 33 && (publicKey[0] === 0x02 || publicKey[0] === 0x03)) {
    return publicKey
  }
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error(
      `Invalid secp256k1 public key: expected 65 bytes with 0x04 prefix or 33 bytes compressed, got ${publicKey.length} bytes`,
    )
  }
  const compressed = new Uint8Array(33)
  // 0x02 if y is even, 0x03 if y is odd
  const yLastByte = publicKey[64] ?? 0
  compressed[0] = (yLastByte & 1) === 0 ? 0x02 : 0x03
  compressed.set(publicKey.slice(1, 33), 1)
  return compressed
}
