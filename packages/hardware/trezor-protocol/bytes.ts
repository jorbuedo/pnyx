/**
 * Pure Uint8Array utility functions replacing Node.js Buffer.
 *
 * Provides allocation, read/write, concatenation, comparison,
 * and encoding helpers that work identically across Node.js,
 * browsers, and React Native without polyfills.
 *
 * @module
 */

export {bytesToHex, hexToBytes} from '../utils'

const dv = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** Concatenate multiple Uint8Arrays into one. */
export const concatBytes = (...arrays: Uint8Array[]): Uint8Array => {
  let length = 0
  for (const a of arrays) length += a.length
  const result = new Uint8Array(length)
  let offset = 0
  for (const a of arrays) {
    result.set(a, offset)
    offset += a.length
  }
  return result
}

/** Compare two byte arrays for equality. */
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Read uint8 at offset. */
export const readUint8 = (bytes: Uint8Array, offset: number): number => dv(bytes).getUint8(offset)

/** Read uint16 big-endian at offset. */
export const readUint16BE = (bytes: Uint8Array, offset: number): number => dv(bytes).getUint16(offset, false)

/** Read uint32 big-endian at offset. */
export const readUint32BE = (bytes: Uint8Array, offset: number): number => dv(bytes).getUint32(offset, false)

/** Read int32 big-endian at offset. */
export const readInt32BE = (bytes: Uint8Array, offset: number): number => dv(bytes).getInt32(offset, false)

/** Write uint8 at offset. Returns bytes for chaining. */
export const writeUint8 = (bytes: Uint8Array, value: number, offset: number): Uint8Array => {
  dv(bytes).setUint8(offset, value)
  return bytes
}

/** Write uint16 big-endian at offset. Returns bytes for chaining. */
export const writeUint16BE = (bytes: Uint8Array, value: number, offset: number): Uint8Array => {
  dv(bytes).setUint16(offset, value, false)
  return bytes
}

/** Write uint32 big-endian at offset. Returns bytes for chaining. */
export const writeUint32BE = (bytes: Uint8Array, value: number, offset: number): Uint8Array => {
  dv(bytes).setUint32(offset, value, false)
  return bytes
}

/** Write int32 big-endian at offset. Returns bytes for chaining. */
export const writeInt32BE = (bytes: Uint8Array, value: number, offset: number): Uint8Array => {
  dv(bytes).setInt32(offset, value, false)
  return bytes
}

const encoder = new TextEncoder()

/** Encode a UTF-8 string to bytes. */
export const utf8ToBytes = (str: string): Uint8Array => encoder.encode(str)

/** Encode an ASCII string to bytes. */
export const asciiToBytes = (str: string): Uint8Array => {
  const bytes = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0x7f
  }
  return bytes
}

/** Base64 string to bytes. */
export const base64ToBytes = (str: string): Uint8Array => {
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** Bytes to base64 string. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
