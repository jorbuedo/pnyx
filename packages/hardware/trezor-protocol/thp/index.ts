/**
 * THP (Trezor Host Protocol) implementation.
 *
 * Supports the encrypted protocol used by Trezor Safe 5/7 devices.
 *
 * @module
 */

// Constants
export {
  CRC_LENGTH,
  HEADER_SIZE,
  MESSAGE_LEN_SIZE,
  TAG_LENGTH,
  THP_CONTROL_BYTE,
  THP_DEFAULT_CHANNEL,
} from './constants'

// Crypto primitives
export {
  aesGcmDecrypt,
  aesGcmEncrypt,
  bigEndianBytesToBigInt,
  crc32,
  curve25519,
  elligator2,
  getCurve25519KeyPair,
  getIvFromNonce,
  hashOfTwo,
  hkdf,
  hmacSha256,
  littleEndianBytesToBigInt,
  sha256,
  sha512,
} from './crypto'
// Decode
export {decode as decodeThp, getCRC, validateCrc} from './decode'
// Encode
export {encode as encodeThp, encodeAck, encodePayload, encodeProtobufMessage} from './encode'
// Handshake orchestration
export type {ThpHandshakeConfig} from './handshake-orchestration'
export {performThpHandshake} from './handshake-orchestration'
// Transport loop
export type {ThpLoopCommonProps} from './loop'
export {callThpMessage, parseThpMessage, receiveThpMessage, sendThpMessage, thpLoop} from './loop'
// Pairing / Handshake
export {
  findKnownPairingCredentials,
  getCpaceHostKeys,
  getHandshakeHash,
  getSharedSecret,
  getTrezorState,
  handleHandshakeInit,
  validateCodeEntryTag,
  validateNfcTag,
  validateQrCodeTag,
} from './pairing'
// Protobuf definitions
export {getThpProtobufDefinitions} from './protobuf-definitions'
// State management
export type {ThpState} from './state'
export {
  createNewSessionId,
  createThpState,
  deserializeThpState,
  getNfcData,
  isAutoconnectPaired,
  resetThpState,
  serializeThpState,
  syncState,
  updateAckBit,
  updateHandshakeCredentials,
  updateNonce,
  updateSyncBit,
} from './state'
// Types
export type {
  DecodedThpMessage,
  ThpChannelState,
  ThpCodeEntryChallenge,
  ThpCodeEntryCommitment,
  ThpCodeEntryCpaceHostTag,
  ThpCodeEntryCpaceTrezor,
  ThpCodeEntrySecret,
  ThpCreateChannelRequest,
  ThpCreateChannelResponse,
  ThpCreateNewSession,
  ThpCredentialRequest,
  ThpCredentialResponse,
  ThpCredentials,
  ThpDeviceProperties,
  ThpEndRequest,
  ThpEndResponse,
  ThpError,
  ThpHandshakeCompletionReqNoisePayload,
  ThpHandshakeCompletionRequest,
  ThpHandshakeCompletionResponse,
  ThpHandshakeCredentials,
  ThpHandshakeInitRequest,
  ThpHandshakeInitResponse,
  ThpMessageResponse,
  ThpMessageSyncBit,
  ThpNfcTagHost,
  ThpNfcTagTrezor,
  ThpPairingPreparationsFinished,
  ThpPairingRequest,
  ThpPairingRequestApproved,
  ThpPhase,
  ThpQrCodeSecret,
  ThpQrCodeTag,
  ThpSelectMethod,
  ThpStateSerialized,
} from './types'
export {ThpPairingMethod} from './types'
// Utils
export {
  addAckBit,
  addSequenceBit,
  clearControlBit,
  getControlBit,
  getExpectedResponses,
  getThpPairingMethod,
  isAckExpected,
  isThpMessageName,
  readThpHeader,
} from './utils'
// v2 protocol framing
export * as v2 from './v2'
