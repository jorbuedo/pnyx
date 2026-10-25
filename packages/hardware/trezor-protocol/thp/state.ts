/**
 * THP channel state management.
 *
 * Replaces the ThpState class from @trezor/protocol with plain functions.
 * All state is stored in a mutable object for compatibility with the
 * send/ack/receive state machine.
 *
 * @module
 */

import {bytesToHex, concatBytes, hexToBytes, writeUint8} from '../bytes'
import type {
  ThpChannelState,
  ThpCredentials,
  ThpDeviceProperties,
  ThpHandshakeCredentials,
  ThpMessageSyncBit,
  ThpPairingMethod,
  ThpPhase,
  ThpStateSerialized,
} from './types'

export type ThpState = {
  // Persisted channel state
  channel: Uint8Array
  sendBit: ThpMessageSyncBit
  recvBit: ThpMessageSyncBit
  sendAckBit: ThpMessageSyncBit
  recvAckBit: ThpMessageSyncBit
  sendNonce: number
  recvNonce: number
  expectedResponses: number[]
  recentMessage: Uint8Array

  // Runtime state (not serialized)
  phase: ThpPhase
  isPaired: boolean
  pairingTagPromise: {abort: () => Promise<void>} | undefined
  cancelablePromise: boolean
  handshakeCredentials: ThpHandshakeCredentials | undefined
  properties: ThpDeviceProperties | undefined
  pairingCredentials: ThpCredentials[]
  selectedMethod: ThpPairingMethod | undefined
  nfcSecret: Uint8Array | undefined
  sessionId: Uint8Array
  sessionIdCounter: number
  /**
   * The device speaks THP 2.1 (`properties.protocol_version_minor > 0`), so the host advertises the
   * same in the HANDSHAKE_INIT_REQ ack bit. Availability only — piggybacking an ack onto a real
   * message is a separate opt-in that pairing never uses.
   */
  piggybackAckAvailable: boolean
}

export const createThpState = (): ThpState => ({
  channel: new Uint8Array(0),
  sendBit: 0,
  recvBit: 0,
  sendAckBit: 0,
  recvAckBit: 0,
  sendNonce: 0,
  recvNonce: 1,
  expectedResponses: [],
  recentMessage: new Uint8Array(0),
  phase: 'handshake',
  isPaired: false,
  pairingTagPromise: undefined,
  cancelablePromise: false,
  handshakeCredentials: undefined,
  properties: undefined,
  pairingCredentials: [],
  selectedMethod: undefined,
  nfcSecret: undefined,
  sessionId: new Uint8Array(1),
  sessionIdCounter: 0,
  piggybackAckAvailable: false,
})

export const resetThpState = (state: ThpState): void => {
  state.phase = 'handshake'
  state.isPaired = false
  state.pairingTagPromise = undefined
  state.cancelablePromise = false
  state.handshakeCredentials = undefined
  state.channel = new Uint8Array(0)
  state.sendBit = 0
  state.sendAckBit = 0
  state.sendNonce = 0
  state.recvBit = 0
  state.recvAckBit = 0
  state.recvNonce = 1
  state.expectedResponses = []
  state.pairingCredentials = []
  state.selectedMethod = undefined
  state.nfcSecret = undefined
  state.sessionId = new Uint8Array(1)
  state.sessionIdCounter = 0
  state.piggybackAckAvailable = false
  state.recentMessage = new Uint8Array(0)
}

export const updateAckBit = (state: ThpState, type: 'send' | 'recv'): void => {
  if (type === 'send') {
    state.sendAckBit = state.sendAckBit > 0 ? 0 : 1
  } else {
    state.recvAckBit = state.recvAckBit > 0 ? 0 : 1
  }
}

export const updateSyncBit = (state: ThpState, type: 'send' | 'recv'): void => {
  if (type === 'send') {
    state.sendBit = state.sendBit > 0 ? 0 : 1
  } else {
    state.recvBit = state.recvBit > 0 ? 0 : 1
  }
}

export const updateNonce = (state: ThpState, type: 'send' | 'recv'): void => {
  if (type === 'send') {
    state.sendNonce += 1
  } else {
    state.recvNonce += 1
  }
}

export const syncState = (state: ThpState, type: 'send' | 'recv', messageType: string): void => {
  const shouldUpdateSyncBit = !['ThpCreateChannelRequest', 'ThpCreateChannelResponse'].includes(messageType)
  if (shouldUpdateSyncBit) {
    updateAckBit(state, type)
    updateSyncBit(state, type)
  }

  const shouldUpdateNonce =
    shouldUpdateSyncBit &&
    ![
      'ThpHandshakeInitRequest',
      'ThpHandshakeInitResponse',
      'ThpHandshakeCompletionRequest',
      'ThpHandshakeCompletionResponse',
    ].includes(messageType)
  if (shouldUpdateNonce) {
    updateNonce(state, type)
  }
}

export const updateHandshakeCredentials = (state: ThpState, newCredentials: Partial<ThpHandshakeCredentials>): void => {
  if (!state.handshakeCredentials) {
    state.handshakeCredentials = {
      pairingMethods: [],
      handshakeHash: new Uint8Array(0),
      handshakeCommitment: new Uint8Array(0),
      codeEntryChallenge: new Uint8Array(0),
      trezorEncryptedStaticPubkey: new Uint8Array(0),
      hostEncryptedStaticPubkey: new Uint8Array(0),
      staticKey: new Uint8Array(0),
      hostStaticPublicKey: new Uint8Array(0),
      hostKey: new Uint8Array(0),
      trezorKey: new Uint8Array(0),
      trezorCpacePublicKey: new Uint8Array(0),
    }
  }

  state.handshakeCredentials = {
    ...state.handshakeCredentials,
    ...newCredentials,
  }
}

export const createNewSessionId = (state: ThpState): Uint8Array => {
  state.sessionIdCounter++
  if (state.sessionIdCounter > 255) {
    state.sessionIdCounter = 1
  }
  const sessionId = new Uint8Array(1)
  writeUint8(sessionId, state.sessionIdCounter, 0)
  state.sessionId = sessionId
  return sessionId
}

export const isAutoconnectPaired = (state: ThpState): boolean =>
  state.isPaired && Boolean(state.pairingCredentials[0]?.autoconnect)

export const getNfcData = (state: ThpState): Uint8Array | undefined => {
  if (state.selectedMethod === 4 /* NFC */ && state.nfcSecret && state.handshakeCredentials) {
    return concatBytes(state.nfcSecret, state.handshakeCredentials.handshakeHash.subarray(0, 16))
  }
  return undefined
}

export const serializeThpState = (state: ThpState): ThpStateSerialized => ({
  properties: state.properties,
  channel: bytesToHex(state.channel),
  sendBit: state.sendBit,
  recvBit: state.recvBit,
  sendAckBit: state.sendAckBit,
  recvAckBit: state.recvAckBit,
  sendNonce: state.sendNonce,
  recvNonce: state.recvNonce,
  expectedResponses: state.expectedResponses.slice(0),
  credentials: state.pairingCredentials.slice(0),
  recentMessage: bytesToHex(state.recentMessage),
})

export const deserializeThpState = (state: ThpState, json: ThpChannelState): void => {
  const error = new Error('ThpState.deserialize invalid state')
  if (!json || typeof json !== 'object') throw error
  if (!Array.isArray(json.expectedResponses)) throw error
  if (typeof json.channel !== 'string') throw error
  if (typeof json.recentMessage !== 'string') throw error

  const nums = [
    json.sendBit,
    json.recvBit,
    json.sendAckBit,
    json.recvAckBit,
    json.sendNonce,
    json.recvNonce,
    ...json.expectedResponses,
  ]
  for (const nr of nums) {
    if (typeof nr !== 'number') throw error
  }

  state.channel = hexToBytes(json.channel)
  state.expectedResponses = json.expectedResponses
  state.sendBit = json.sendBit
  state.recvBit = json.recvBit
  state.sendAckBit = json.sendAckBit
  state.recvAckBit = json.recvAckBit
  state.sendNonce = json.sendNonce
  state.recvNonce = json.recvNonce
  state.recentMessage = hexToBytes(json.recentMessage)
}
