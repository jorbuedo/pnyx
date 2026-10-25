/**
 * Protocol v1 encode/decode for legacy Trezor devices.
 *
 * Header format: [0x3F, 0x23, 0x23] + messageType(uint16BE) + length(uint32BE) = 9 bytes
 *
 * Ported from trezor-suite/packages/protocol/src/protocol-v1/
 *
 * @module
 */

import {readUint8, readUint16BE, readUint32BE, writeUint8, writeUint16BE, writeUint32BE} from './bytes'
import {PROTOCOL_MALFORMED} from './errors'
import type {DecodedProtocolMessage} from './types'

// --- Constants ---

/** Magic byte 0x3F = '?' */
const MAGIC = 0x3f
/** Header delimiter 0x23 = '#' */
const SHARP = 0x23
/** Total header size: magic(1) + sharp(1) + sharp(1) + messageType(2) + length(4) = 9 */
const HEADER_SIZE = 9

// --- Headers ---

/**
 * Returns the header prefix `[0x3F, 0x23, 0x23]` and the chunk header `[0x3F]`.
 */
export const getHeaders = (): [header: Uint8Array, chunkHeader: Uint8Array] => {
  const header = new Uint8Array(3)
  writeUint8(header, MAGIC, 0)
  writeUint8(header, SHARP, 1)
  writeUint8(header, SHARP, 2)

  const chunkHeader = new Uint8Array([MAGIC])

  return [header, chunkHeader]
}

// --- Encode ---

/**
 * Encode a protobuf-encoded payload into a v1 protocol frame.
 *
 * @param data - The protobuf-encoded payload bytes
 * @param messageType - The numeric message type ID
 * @returns Complete frame buffer: header(9) + payload
 */
export const encode = (data: Uint8Array, messageType: number): Uint8Array => {
  const fullSize = HEADER_SIZE + data.length
  const encoded = new Uint8Array(fullSize)

  // Write 3-byte header prefix
  const [header] = getHeaders()
  encoded.set(header)

  // Write message type as big-endian uint16 at offset 3
  writeUint16BE(encoded, messageType, 3)

  // Write data length as big-endian uint32 at offset 5
  writeUint32BE(encoded, data.length, 5)

  // Copy payload starting at offset 9
  encoded.set(data, HEADER_SIZE)

  return encoded
}

// --- Decode ---

/**
 * Decode the first chunk of a v1 protocol message.
 *
 * Validates the header magic bytes and extracts the message type,
 * total payload length, and the payload portion from this chunk.
 *
 * @param bytes - Raw bytes from the first HID report
 * @returns Decoded header info + payload slice
 * @throws Error with PROTOCOL_MALFORMED if header is invalid
 */
export const decode = (bytes: Uint8Array): DecodedProtocolMessage => {
  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error(PROTOCOL_MALFORMED)
  }

  const magic = readUint8(bytes, 0)
  const sharp1 = readUint8(bytes, 1)
  const sharp2 = readUint8(bytes, 2)
  const messageType = readUint16BE(bytes, 3)
  const length = readUint32BE(bytes, 5)

  if (magic !== MAGIC || sharp1 !== SHARP || sharp2 !== SHARP) {
    throw new Error(PROTOCOL_MALFORMED)
  }

  return {
    header: bytes.subarray(0, 3),
    length,
    messageType,
    payload: bytes.subarray(HEADER_SIZE),
  }
}
