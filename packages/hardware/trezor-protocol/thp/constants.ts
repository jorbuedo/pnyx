/**
 * THP protocol constants.
 *
 * @module
 */

export const THP_DEFAULT_CHANNEL = new Uint8Array([0xff, 0xff])

export const CRC_LENGTH = 4
export const TAG_LENGTH = 16

// v2 protocol header sizes
export const HEADER_SIZE = 3 // 1 control_byte + 2 channel
export const MESSAGE_LEN_SIZE = 2

// Control byte values for THP messages
export const THP_CONTROL_BYTE = {
  HANDSHAKE_INIT_REQ: 0x00, // out
  HANDSHAKE_INIT_RES: 0x01, // in
  HANDSHAKE_COMP_REQ: 0x02, // out
  HANDSHAKE_COMP_RES: 0x03, // in
  ENCRYPTED: 0x04, // in / out
  ACK_MESSAGE: 0x20, // in / out
  CHANNEL_ALLOCATION_REQ: 0x40, // out
  CHANNEL_ALLOCATION_RES: 0x41, // in
  ERROR: 0x42, // in
  PING: 0x43, // out
  PONG: 0x44, // in
  CONTINUATION_PACKET: 0x80, // in / out
} as const
