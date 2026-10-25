/**
 * THP protocol utility functions.
 *
 * Bit manipulation helpers for THP control bytes, header reading,
 * and message type classification.
 *
 * @module
 */

import {readUint8} from '../bytes'
import {THP_CONTROL_BYTE} from './constants'
import type {ThpMessageSyncBit, ThpPairingMethod} from './types'

export const addAckBit = (magic: number, ackBit: number): Uint8Array => {
  return new Uint8Array([magic | (ackBit << 3)])
}

export const addSequenceBit = (magic: number, seqBit: number): Uint8Array => {
  return new Uint8Array([magic | (seqBit << 4)])
}

// Clear bits 3 (ack) and 4 (sequence)
export const clearControlBit = (magic: number): number => magic & ~(1 << 3) & ~(1 << 4)

export const getControlBit = (magic: number): {ackBit: ThpMessageSyncBit; sequenceBit: ThpMessageSyncBit} => {
  const ackBit: ThpMessageSyncBit = (magic & (1 << 3)) === 0 ? 0 : 1
  const sequenceBit: ThpMessageSyncBit = (magic & (1 << 4)) === 0 ? 0 : 1
  return {ackBit, sequenceBit}
}

export const readThpHeader = (
  bytes: Uint8Array,
): {magic: number; ackBit: ThpMessageSyncBit; sequenceBit: ThpMessageSyncBit; channel: Uint8Array} => {
  const magic = readUint8(bytes, 0)
  const {ackBit, sequenceBit} = getControlBit(magic)
  const channel = bytes.subarray(1, 3)
  return {magic: clearControlBit(magic), ackBit, sequenceBit, channel}
}

// Check if ThpAck is expected for this message type
export const isAckExpected = (bytesOrMagic: Uint8Array | number[]): boolean => {
  const isCreateChannelMessage = (magic: number) =>
    magic === THP_CONTROL_BYTE.CHANNEL_ALLOCATION_REQ || magic === THP_CONTROL_BYTE.CHANNEL_ALLOCATION_RES

  if (Array.isArray(bytesOrMagic)) {
    return !bytesOrMagic.find((n) => isCreateChannelMessage(n))
  }

  return !isCreateChannelMessage(readUint8(bytesOrMagic, 0))
}

// Get expected response control bytes for a given request
export const getExpectedResponses = (bytes: Uint8Array): number[] => {
  const {magic} = readThpHeader(bytes)

  if (magic === THP_CONTROL_BYTE.CHANNEL_ALLOCATION_REQ) {
    return [THP_CONTROL_BYTE.CHANNEL_ALLOCATION_RES]
  }
  if (magic === THP_CONTROL_BYTE.HANDSHAKE_INIT_REQ) {
    return [THP_CONTROL_BYTE.HANDSHAKE_INIT_RES, THP_CONTROL_BYTE.CONTINUATION_PACKET]
  }
  if (magic === THP_CONTROL_BYTE.HANDSHAKE_COMP_REQ) {
    return [THP_CONTROL_BYTE.HANDSHAKE_COMP_RES, THP_CONTROL_BYTE.CONTINUATION_PACKET]
  }
  if (magic === THP_CONTROL_BYTE.ENCRYPTED) {
    return [THP_CONTROL_BYTE.ENCRYPTED, THP_CONTROL_BYTE.CONTINUATION_PACKET]
  }

  return []
}

export const isThpMessageName = (name: string): boolean =>
  ['ThpCreateChannelRequest', 'ThpHandshakeInitRequest', 'ThpHandshakeCompletionRequest', 'ThpReadAck'].includes(name)

export const getThpPairingMethod = (dm: ThpPairingMethod | string): ThpPairingMethod => {
  if (typeof dm === 'number') return dm
  const map: Record<string, ThpPairingMethod> = {
    SkipPairing: 1,
    CodeEntry: 2,
    QrCode: 3,
    NFC: 4,
  }
  const result = map[dm]
  if (result === undefined) throw new Error(`Unknown pairing method: ${dm}`)
  return result
}
