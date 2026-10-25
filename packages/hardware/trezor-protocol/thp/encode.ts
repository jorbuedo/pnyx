/**
 * THP frame encoding.
 *
 * Builds outgoing THP frames including channel allocation, handshake,
 * encrypted protobuf, and ACK messages. All frames end with CRC-32.
 *
 * @module
 */

import {concatBytes, hexToBytes, writeUint16BE} from '../bytes'
import {CRC_LENGTH, TAG_LENGTH, THP_CONTROL_BYTE, THP_DEFAULT_CHANNEL} from './constants'
import {aesGcmEncrypt, crc32, getIvFromNonce} from './crypto'
import type {ThpState} from './state'
import {addAckBit, addSequenceBit, isThpMessageName} from './utils'

// --- Payload builders for THP-layer messages ---

const getBytesFromField = (data: Record<string, unknown>, fieldName: string): Uint8Array | undefined => {
  const value = data[fieldName]
  if (typeof value === 'string') return hexToBytes(value)
  if (typeof value === 'number') return new Uint8Array([value])
  if (value instanceof Uint8Array) return value
  return undefined
}

const createChannelRequestPayload = (data: Record<string, unknown>): Uint8Array => {
  const nonce = getBytesFromField(data, 'nonce')
  if (!nonce) throw new Error('Missing nonce field')
  return nonce
}

const handshakeInitRequestPayload = (data: Record<string, unknown>): Uint8Array => {
  const key = getBytesFromField(data, 'key')
  if (!key) throw new Error('ThpHandshakeInitRequest missing key field')
  const tryToUnlock = getBytesFromField(data, 'tryToUnlock') ?? new Uint8Array([0])
  return concatBytes(key, tryToUnlock)
}

const handshakeCompletionRequestPayload = (data: Record<string, unknown>): Uint8Array => {
  const hostPubkey = getBytesFromField(data, 'hostPubkey')
  if (!hostPubkey) throw new Error('ThpHandshakeCompletionRequest missing hostPubkey field')
  const encryptedPayload = getBytesFromField(data, 'encryptedPayload')
  if (!encryptedPayload) throw new Error('ThpHandshakeCompletionRequest missing encryptedPayload field')
  return concatBytes(hostPubkey, encryptedPayload)
}

export const encodePayload = (name: string, data: Record<string, unknown>): Uint8Array => {
  if (name === 'ThpCreateChannelRequest') return createChannelRequestPayload(data)
  if (name === 'ThpHandshakeInitRequest') return handshakeInitRequestPayload(data)
  if (name === 'ThpHandshakeCompletionRequest') return handshakeCompletionRequestPayload(data)
  return new Uint8Array(0)
}

// --- Frame builders ---

const createChannelRequest = (data: Uint8Array, channel: Uint8Array): Uint8Array => {
  const length = new Uint8Array(2)
  writeUint16BE(length, data.length + CRC_LENGTH, 0)
  const magic = new Uint8Array([THP_CONTROL_BYTE.CHANNEL_ALLOCATION_REQ])
  const message = concatBytes(magic, channel, length, data)
  const crc = crc32(message)
  return concatBytes(message, crc)
}

/**
 * `piggybackAckAvailable` rides in the ack bit of the magic byte — this is how the host tells a
 * THP 2.1 device it speaks 2.1 (`protocol_version_minor > 0`, from the channel response). Sending the
 * bare control byte leaves the device on a different ACK discipline than the host follows, and the
 * first place that can surface is the first ENCRYPTED frame after the handshake.
 *
 * Advertising availability is not the same as using it: upstream only piggybacks an ack onto a real
 * message inside bulk flows (`signTransaction`, `applySettings`, `changeLanguage`) and never during
 * pairing, so `encodeProtobufMessage` deliberately stays unchanged.
 */
const handshakeInitRequest = (data: Uint8Array, channel: Uint8Array, piggybackAckAvailable: boolean): Uint8Array => {
  const length = new Uint8Array(2)
  writeUint16BE(length, data.length + CRC_LENGTH, 0)
  const magic = addAckBit(THP_CONTROL_BYTE.HANDSHAKE_INIT_REQ, piggybackAckAvailable ? 1 : 0)
  const message = concatBytes(magic, channel, length, data)
  const crc = crc32(message)
  return concatBytes(message, crc)
}

const handshakeCompletionRequest = (data: Uint8Array, channel: Uint8Array, sendBit: number): Uint8Array => {
  const length = new Uint8Array(2)
  writeUint16BE(length, data.length + CRC_LENGTH, 0)
  const magic = addSequenceBit(THP_CONTROL_BYTE.HANDSHAKE_COMP_REQ, sendBit)
  const message = concatBytes(magic, channel, length, data)
  const crc = crc32(message)
  return concatBytes(message, crc)
}

const encodeThpMessage = (
  messageType: string,
  data: Uint8Array,
  channel: Uint8Array,
  thpState: ThpState,
): Uint8Array => {
  if (messageType === 'ThpCreateChannelRequest') return createChannelRequest(data, channel)
  if (messageType === 'ThpHandshakeInitRequest')
    return handshakeInitRequest(data, channel, thpState.piggybackAckAvailable)
  if (messageType === 'ThpHandshakeCompletionRequest') {
    return handshakeCompletionRequest(data, channel, thpState.sendBit || 0)
  }
  throw new Error(`Unknown Thp message type ${messageType}`)
}

// --- Encrypted protobuf message ---

export const encodeProtobufMessage = (
  messageType: number,
  data: Uint8Array,
  channel: Uint8Array,
  thpState: ThpState,
): Uint8Array => {
  if (!thpState.handshakeCredentials) throw new Error('ThpStateMissing')

  const length = new Uint8Array(2)
  writeUint16BE(length, 1 + 2 + data.length + TAG_LENGTH + CRC_LENGTH, 0)

  const magic = addSequenceBit(THP_CONTROL_BYTE.ENCRYPTED, thpState.sendBit)
  const header = concatBytes(magic, channel)

  const messageTypeBytes = new Uint8Array(2)
  writeUint16BE(messageTypeBytes, messageType, 0)

  const plaintext = concatBytes(thpState.sessionId, messageTypeBytes, data)
  const iv = getIvFromNonce(thpState.sendNonce)
  const {ciphertext, tag} = aesGcmEncrypt(thpState.handshakeCredentials.hostKey, iv, new Uint8Array(0), plaintext)

  const message = concatBytes(header, length, ciphertext, tag)
  const crc = crc32(message)

  return concatBytes(message, crc)
}

// --- ACK message ---

export const encodeAck = (state: ThpState): Uint8Array => {
  const length = new Uint8Array(2)
  writeUint16BE(length, CRC_LENGTH, 0)
  const magic = addAckBit(THP_CONTROL_BYTE.ACK_MESSAGE, state.recvAckBit)
  const message = concatBytes(magic, state.channel, length)
  const crc = crc32(message)
  return concatBytes(message, crc)
}

// --- Top-level encode ---

type ProtobufEncoder = (
  messageName: string,
  messageData: Record<string, unknown>,
) => {messageType: number; message: Uint8Array}

export const encode = (options: {
  messageName: string
  data: Record<string, unknown>
  thpState: ThpState
  protobufEncoder: ProtobufEncoder
}): Uint8Array => {
  const channel = options.thpState.channel.length > 0 ? options.thpState.channel : THP_DEFAULT_CHANNEL
  const {messageName, data, protobufEncoder, thpState} = options

  if (isThpMessageName(messageName)) {
    const payload = encodePayload(messageName, data)
    return encodeThpMessage(messageName, payload, channel, thpState)
  }

  const {messageType, message} = protobufEncoder(messageName, data)
  return encodeProtobufMessage(messageType, message, channel, thpState)
}
