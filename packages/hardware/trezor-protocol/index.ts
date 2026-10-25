/**
 * Trezor protocol implementation.
 *
 * Replaces @trezor/protobuf, @trezor/protocol, @trezor/transport utilities,
 * and @trezor/utils with minimal own implementations.
 *
 * @module
 */

// Bridge HTTP transport (for E2E testing via trezord-go)
export type {BridgeDeviceDescriptor, BridgeTransportConfig} from './bridge-transport'
export {createBridgeTransport} from './bridge-transport'
export type {DeviceCallbacks, TransportCall} from './call-loop'
// Call loop + device session
export {sendSequence, typedCall} from './call-loop'
// Transport constants
export {
  ACTION_TIMEOUT,
  CONFIGURATION_ID,
  DEBUGLINK_ENDPOINT_ID,
  DEBUGLINK_INTERFACE_ID,
  DEVICE_TYPE,
  ENDPOINT_ID,
  INTERFACE_ID,
  T1_HID_PRODUCT,
  T1_HID_VENDOR,
  TRANSPORT,
  TREZOR_USB_DESCRIPTORS,
  WEBUSB_BOOTLOADER_PRODUCT,
} from './constants'
export type {
  BitcoinSignTxParams,
  BitcoinSignTxResult,
  CardanoSignTxParams,
  CardanoSignTxResult,
  DeviceSession,
  DeviceSessionConfig,
  EIP712Types,
  TransportAdapter,
} from './device-session'
export {
  acquireSession,
  bitcoinSignTx,
  cardanoSignTx,
  ethereumSignTx,
  ethereumSignTypedData,
  initializeDevice,
  solanaSignTx,
} from './device-session'
// Error constants
export * as ERRORS from './errors'
export {PROTOCOL_MALFORMED, PROTOCOL_MISMATCH_VERSION} from './errors'
export type {MessageResponse} from './protobuf'
// Protobuf encode/decode
export {decodeMessage, encodeMessage, loadDefinitions, parseConfigure} from './protobuf'
// THP protocol (Safe 5/7 encrypted protocol)
export * as thp from './thp/index'
// Transport message building, chunking, send/receive
export {buildMessage, createChunks, receive, receiveAndParse, sendChunks} from './transport'
// Types
export type {
  ApiType,
  DecodedProtocolMessage,
  Descriptor,
  DescriptorApiLevel,
  Logger,
  PathInternal,
  PathPublic,
  Session,
} from './types'
export {
  PathInternal as makePathInternal,
  PathPublic as makePathPublic,
  Session as makeSession,
} from './types'
// Utility functions
export {
  arrayPartition,
  createDeferred,
  getSynchronize,
  readMessageBuffer,
  resolveAfter,
  scheduleAction,
} from './utils'
// Protocol v1 (legacy devices)
export * as v1 from './v1'
