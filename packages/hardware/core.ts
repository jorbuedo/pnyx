/**
 * Core exports.
 *
 * This module exports all hardware wallet functionality EXCEPT the multi-chain
 * Ledger apps (Bitcoin, Ethereum, Solana) which have Node.js-only dependencies.
 *
 * Use this import path for React Native and browser environments:
 * ```typescript
 * import { ledger, trezor, derivation } from '@pnyx/hardware/core'
 * ```
 *
 * For the full package including multi-chain Ledger apps (Node.js only):
 * ```typescript
 * import { ledger, trezor, ledgerApps } from '@pnyx/hardware'
 * ```
 *
 * @module
 */

export type {
  ConfirmationCallbacks,
  ConfirmationConfig,
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
// Re-export submodules (excluding ledgerApps)
export * as ledger from './ledger'
// Ledger transport types
export type {LedgerTransport, LedgerTransportFactory} from './ledger/types'
export * as trezor from './trezor'
// Main types
export type {
  AppType,
  AppVersion,
  CardanoAppCapabilities,
  CardanoMessageAddressParams,
  CardanoSigningRequest,
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
  DEFAULT_TIMEOUT,
  DeviceLockedError,
  DeviceNotConnectedError,
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
// Shared crypto utilities
export {compressSecp256k1PublicKey} from './utils'
