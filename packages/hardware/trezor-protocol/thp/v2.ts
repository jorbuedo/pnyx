/**
 * Protocol v2 framing for THP.
 *
 * Handles the raw byte-level encode/decode of v2 protocol frames,
 * which are the transport-layer framing used by THP messages.
 *
 * @module
 */

import {concatBytes, readUint8, readUint16BE} from '../bytes'
import {PROTOCOL_MALFORMED} from '../errors'
import {HEADER_SIZE, MESSAGE_LEN_SIZE, THP_CONTROL_BYTE} from './constants'
import type {DecodedThpMessage} from './types'

const getChunkHeader = (data: Uint8Array): Uint8Array => {
  if (data.byteLength < HEADER_SIZE) {
    throw new Error(PROTOCOL_MALFORMED)
  }
  const channel = data.subarray(1, HEADER_SIZE)
  return concatBytes(new Uint8Array([THP_CONTROL_BYTE.CONTINUATION_PACKET]), channel)
}

export const getHeaders = (data: Uint8Array): [Uint8Array, Uint8Array] => {
  const chunkHeader = getChunkHeader(data)
  return [data.subarray(0, HEADER_SIZE), chunkHeader]
}

// Decode control byte to canonical message type (strip ack/sequence bits)
export const decodeCtrlByte = (ctrlByte: number): number | undefined => {
  // DATA message types (mask off ack bit 3 and sequence bit 4)
  const dataType = ctrlByte & 0xe7
  switch (dataType) {
    case THP_CONTROL_BYTE.HANDSHAKE_COMP_REQ:
    case THP_CONTROL_BYTE.HANDSHAKE_COMP_RES:
    case THP_CONTROL_BYTE.HANDSHAKE_INIT_REQ:
    case THP_CONTROL_BYTE.HANDSHAKE_INIT_RES:
    case THP_CONTROL_BYTE.ENCRYPTED:
      return dataType
  }

  // ACK message (mask off ack bit only)
  const ackType = ctrlByte & 0xf7
  if (ackType === THP_CONTROL_BYTE.ACK_MESSAGE) {
    return ackType
  }

  // Unmasked message types
  switch (ctrlByte) {
    case THP_CONTROL_BYTE.CHANNEL_ALLOCATION_REQ:
    case THP_CONTROL_BYTE.CHANNEL_ALLOCATION_RES:
    case THP_CONTROL_BYTE.PING:
    case THP_CONTROL_BYTE.PONG:
    case THP_CONTROL_BYTE.ERROR:
      return ctrlByte
  }

  return undefined
}

export const decode = (bytes: Uint8Array): DecodedThpMessage => {
  if (bytes.byteLength < HEADER_SIZE + MESSAGE_LEN_SIZE) {
    throw new Error(PROTOCOL_MALFORMED)
  }

  const messageType = decodeCtrlByte(readUint8(bytes, 0))
  if (messageType === undefined) {
    throw new Error(PROTOCOL_MALFORMED)
  }

  const [header, chunkHeader] = getHeaders(bytes)

  return {
    header,
    chunkHeader,
    length: readUint16BE(bytes, HEADER_SIZE),
    messageType,
    payload: bytes.subarray(HEADER_SIZE + MESSAGE_LEN_SIZE),
  }
}
