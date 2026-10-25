/**
 * CRC-32 (IEEE 802.3), as used throughout Uniform Resources.
 *
 * Lives here rather than in `@pnyx/crypto` on purpose: it is a UR format detail, not a
 * cryptographic primitive, and nothing outside this package should reach for it as one. It
 * appears twice in the spec — as the Bytewords trailer, and as the `checksum` field that seeds
 * fountain-part selection — so both layers share this implementation.
 *
 * @module
 */

const POLYNOMIAL = 0xedb88320

/**
 * The reflected table, built once. 256 entries derived from the polynomial rather than written
 * out, so there is no transcription to get wrong.
 */
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? POLYNOMIAL ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 of `data`, as an unsigned 32-bit number. */
export const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of data) {
    // biome-ignore lint/style/noNonNullAssertion: index is masked to 0..255, always in range.
    crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** CRC-32 as 4 bytes, big-endian ("network order"), which is how the spec serializes it. */
export const crc32Bytes = (data: Uint8Array): Uint8Array => {
  const crc = crc32(data)
  return Uint8Array.from([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff])
}
