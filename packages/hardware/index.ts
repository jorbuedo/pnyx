/**
 * ./index.js
 *
 * Hardware wallet support for Pnyx.
 *
 * Provides Effect-based interfaces for Ledger and Trezor hardware wallets
 * with comprehensive Cardano support and multichain extensibility.
 *
 * ## Features
 *
 * - **Ledger Support**: USB and Bluetooth transports, Cardano app integration
 * - **Trezor Support**: WebUSB transport, TrezorConnect integration
 * - **Effect-TS**: All operations return typed Effects with comprehensive errors
 * - **Multichain Ready**: Architecture supports extension to other chains
 *
 * ## Usage
 *
 * ```typescript
 * import { createLedgerDevice, createTrezorDevice } from './index.js'
 * import { Effect } from 'effect'
 *
 * // Create a Ledger device
 * const ledger = createLedgerDevice(transportFactory, {
 *   type: 'ledger',
 *   minAppVersion: '2.2.1',
 * })
 *
 * // Get extended public key
 * const xpub = await Effect.runPromise(
 *   ledger.getExtendedPublicKey("m/1852'/1815'/0'")
 * )
 * ```
 *
 * ## Platform Support
 *
 * - **Browser Extension**: WebHID/WebUSB transports
 * - **React Native**: USB HID and Bluetooth transports (requires native modules)
 * - **Node.js**: USB HID transport (requires node-hid)
 *
 * ## Required Dependencies
 *
 * For Ledger support:
 * - `@ledgerhq/hw-transport-*` (platform-specific)
 * - `@cardano-foundation/ledgerjs-hw-app-cardano`
 *
 * For Trezor support:
 * - `@trezor/protobuf` (message schemas; the wire protocol itself is the
 *   in-repo `trezor-protocol/` THP stack — no `@trezor/connect` dependency)
 *
 * @module
 */

// Chain app type maps and helper
export type {
  CardanoChainApp,
  ChainAppMap,
  LedgerChainAppMap,
  TrezorChainAppMap,
} from './chain-apps'
export {getTypedChainApp} from './chain-apps'
export type {
  ConfirmationCallbacks,
  ConfirmationConfig,
  ConfirmationMessageKey,
  ConfirmationSetOptions,
  ConfirmationState,
  ConfirmationStateCallback,
  ConfirmationStateManager,
  ProgressCallback,
} from './confirmation'
export * as confirmation from './confirmation'
// Confirmation flow
export {
  createConfirmationRef,
  createConfirmationStateManager,
  DefaultMessages,
  getConfirmationMessage,
  isOperationActive,
  isOperationComplete,
  isOperationSuccessful,
  refConfirmationCallbacks,
  withConfirmation,
} from './confirmation'
export * as derivation from './derivation'
// Re-export submodules
export * as ledger from './ledger'
// Ledger transport types
export type {LedgerTransport, LedgerTransportFactory} from './ledger/types'
export * as ledgerApps from './ledger-apps'
export * as trezor from './trezor'
// Main types
export type {
  AppType,
  AppVersion,
  CardanoAppCapabilities,
  CardanoMessageAddressParams,
  CardanoSigningRequest,
  ChainAppType,
  CIP36RegistrationParams,
  DerivationPath,
  DerivationPathComponent,
  DeviceFeatures,
  DeviceInfo,
  DeviceStatus,
  DeviceType,
  ExtendedPublicKey,
  HardwareConfig,
  HardwareDevice,
  HardwareErrorType,
  HardwareSignature,
  LedgerConfig,
  LedgerDeviceFeatures,
  LedgerModel,
  MessageSigningRequest,
  TransactionWitness,
  Transport,
  TransportFactory,
  TransportOptions,
  TransportType,
  TrezorConfig,
  TrezorDeviceFeatures,
  TrezorModel,
} from './types'
// Error types
export {
  AppNotOpenError,
  BluetoothNotReadyError,
  type BluetoothNotReadyReason,
  DEFAULT_TIMEOUT,
  DeviceLockedError,
  DeviceNotConnectedError,
  DevicePairingLostError,
  DeviceTimeoutError,
  HardwareError,
  IncorrectDeviceError,
  LEDGER_CIP36_VERSION,
  LEDGER_CIP1694_VERSION,
  LEDGER_VENDOR_ID,
  type LedgerAppRequiredSetting,
  MIN_LEDGER_CARDANO_VERSION,
  TransportError,
  UnknownAppError,
  UserRejectedError,
  VersionTooOldError,
} from './types'
