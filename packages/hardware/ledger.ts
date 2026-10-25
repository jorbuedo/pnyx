/**
 * Ledger hardware wallet support.
 *
 * Provides Effect-based interface for Ledger device operations
 * with comprehensive Cardano support.
 *
 * @module
 */

// Chain support and app mapping
export type {LedgerAppIcon, LedgerAppInfo} from './ledger/chains'
export {
  getAppForChain,
  getAppIdForChain,
  groupChainsByApp,
  isChainSupported,
  LEDGER_APPS,
  SUPPORTED_CHAINS,
} from './ledger/chains'
export {createLedgerDevice, getCardanoAppCapabilities} from './ledger/device'
export {
  compareVersions,
  DeviceStatusCodes,
  isAppNotOpenError,
  isConnectionError,
  isDeviceLockedError,
  isPairingLostError,
  isStaleSessionError,
  isTimeoutError,
  isUserRejectionError,
  isWrongAppError,
  mapLedgerError,
  meetsMinimumVersion,
  parseVersion,
  validateAppVersion,
} from './ledger/errors'
export {isBrowser, isNode, isReactNative, type TransportModule} from './ledger/transports'
export type {
  LedgerAddressParams,
  LedgerAddressType,
  LedgerAppAndVersion,
  LedgerAssetGroup,
  LedgerCertificate,
  LedgerConnectionState,
  LedgerConnectOptions,
  LedgerGetExtendedPublicKeyRequest,
  LedgerGetExtendedPublicKeyResponse,
  LedgerOutputDestinationType,
  LedgerSerial,
  LedgerSignMessageRequest,
  LedgerSignMessageResponse,
  LedgerSignTxRequest,
  LedgerSignTxResponse,
  LedgerToken,
  LedgerTransport,
  LedgerTransportFactory,
  LedgerTxInput,
  LedgerTxOutput,
  LedgerWithdrawal,
} from './ledger/types'
export {formatDerivationPath, parseDerivationPath} from './utils'
