/**
 * THP frame decoding.
 *
 * Parses incoming THP frames: channel allocation responses, handshake
 * messages, encrypted protobuf, ACK, and error messages.
 *
 * @module
 */

import {bytesEqual, bytesToHex, concatBytes, readUint16BE, writeUint16BE} from '../bytes'
import {CRC_LENGTH, TAG_LENGTH, THP_CONTROL_BYTE} from './constants'
import {aesGcmDecrypt, crc32, getIvFromNonce} from './crypto'
import {getHandshakeHash, getTrezorState} from './pairing'
import type {ThpState} from './state'
import type {DecodedThpMessage, ThpDeviceProperties, ThpError, ThpMessageResponse} from './types'

// Protobuf decoder function type
type ProtobufDecoder = (
  messageType: string | number,
  payload: Uint8Array,
) => {type: string; message: Record<string, unknown>}

// --- CRC utilities ---

export const getCRC = (decodedMessage: DecodedThpMessage): Uint8Array =>
  decodedMessage.payload.subarray(decodedMessage.length - CRC_LENGTH, decodedMessage.length)

export const validateCrc = (decodedMessage: DecodedThpMessage): void => {
  const payloadLen = decodedMessage.length - CRC_LENGTH
  const length = new Uint8Array(2)
  writeUint16BE(length, decodedMessage.length, 0)
  const expectedCrc = crc32(concatBytes(decodedMessage.header, length, decodedMessage.payload.subarray(0, payloadLen)))
  const crc = getCRC(decodedMessage)

  if (!bytesEqual(expectedCrc, crc)) {
    throw new Error(`Invalid CRC. expected: ${bytesToHex(expectedCrc)} received: ${bytesToHex(crc)}`)
  }
}

// --- Individual message decoders ---

const createChannelResponse = (
  payload: Uint8Array,
  protobufDecoder: ProtobufDecoder,
): ThpMessageResponse<'ThpCreateChannelResponse'> => {
  const nonce = payload.subarray(0, 8)
  const channel = payload.subarray(8, 10)
  const props = payload.subarray(10, payload.length - CRC_LENGTH)
  const properties = protobufDecoder('ThpDeviceProperties', props).message as unknown as ThpDeviceProperties
  const handshakeHash = getHandshakeHash(props)

  return {
    type: 'ThpCreateChannelResponse',
    message: {nonce, channel, properties, handshakeHash} as unknown as Record<string, unknown>,
  }
}

const readHandshakeInitResponse = (payload: Uint8Array): ThpMessageResponse<'ThpHandshakeInitResponse'> => {
  const trezorEphemeralPubkey = payload.subarray(0, 32)
  const trezorEncryptedStaticPubkey = payload.subarray(32, 32 + 48)
  const tag = payload.subarray(32 + 48, 32 + 48 + TAG_LENGTH)

  return {
    type: 'ThpHandshakeInitResponse',
    message: {trezorEphemeralPubkey, trezorEncryptedStaticPubkey, tag} as unknown as Record<string, unknown>,
  }
}

const readHandshakeCompletionResponse = (
  payload: Uint8Array,
  thpState: ThpState,
): ThpMessageResponse<'ThpHandshakeCompletionResponse'> => {
  if (!thpState.handshakeCredentials) throw new Error('ThpStateMissing')
  const state = getTrezorState(thpState.handshakeCredentials, payload)

  return {
    type: 'ThpHandshakeCompletionResponse',
    message: {state} as unknown as Record<string, unknown>,
  }
}

const readProtobufMessage = (
  payload: Uint8Array,
  thpState: ThpState,
  protobufDecoder: ProtobufDecoder,
): ThpMessageResponse => {
  if (!thpState.handshakeCredentials) throw new Error('ThpStateMissing')

  const tagPos = payload.length - TAG_LENGTH - CRC_LENGTH
  const cipheredMessage = payload.subarray(0, tagPos)
  const tag = payload.subarray(tagPos, payload.length - CRC_LENGTH)

  const iv = getIvFromNonce(thpState.recvNonce)
  const deciphered = aesGcmDecrypt(thpState.handshakeCredentials.trezorKey, iv, new Uint8Array(0), cipheredMessage, tag)

  // Strip the session_id (first byte) — the device echoes back what the host sent.
  // The host manages the session ID via createNewSessionId(); we do not update
  // thpState.sessionId from responses (matches trezor-suite decode behaviour).
  const messagePayload = deciphered.subarray(1)
  const messageType = readUint16BE(messagePayload, 0)
  const protobufPayload = messagePayload.subarray(2)

  return protobufDecoder(messageType, protobufPayload) as ThpMessageResponse
}

const decodeReadAck = (): ThpMessageResponse<'ThpAck'> => ({
  type: 'ThpAck',
  message: {},
})

const decodeThpError = (payload: Uint8Array): ThpMessageResponse<'ThpError'> => {
  const errorType = payload[0]

  const code = (() => {
    switch (errorType) {
      case 0x01:
        return 'ThpTransportBusy' as const
      case 0x02:
        return 'ThpUnallocatedChannel' as const
      case 0x03:
        return 'ThpDecryptionFailed' as const
      case 0x05:
        return 'ThpDeviceLocked' as const
      default:
        return 'ThpUnknownError' as const
    }
  })()

  const errorMessage: ThpError = {
    code,
    message: code ?? `Unknown ThpError ${errorType}`,
  }

  return {
    type: 'ThpError',
    message: errorMessage as unknown as Record<string, unknown>,
  }
}

// --- Top-level decode ---

export const decode = (
  decodedMessage: DecodedThpMessage,
  protobufDecoder: ProtobufDecoder,
  thpState: ThpState,
): ThpMessageResponse => {
  const {messageType, payload} = decodedMessage

  if (messageType === THP_CONTROL_BYTE.ERROR) {
    return decodeThpError(payload)
  }

  if (messageType === THP_CONTROL_BYTE.ACK_MESSAGE) {
    return decodeReadAck()
  }

  if (messageType === THP_CONTROL_BYTE.CHANNEL_ALLOCATION_RES) {
    return createChannelResponse(payload, protobufDecoder)
  }

  if (messageType === THP_CONTROL_BYTE.HANDSHAKE_INIT_RES) {
    return readHandshakeInitResponse(payload)
  }

  if (messageType === THP_CONTROL_BYTE.HANDSHAKE_COMP_RES) {
    return readHandshakeCompletionResponse(payload, thpState)
  }

  if (messageType === THP_CONTROL_BYTE.ENCRYPTED) {
    return readProtobufMessage(payload, thpState, protobufDecoder)
  }

  throw new Error(`Unknown message type: ${messageType}`)
}
