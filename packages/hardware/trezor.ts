/**
 * Trezor hardware wallet support.
 *
 * Provides Effect-based interface for Trezor device operations
 * with Cardano support.
 *
 * @module
 */

// Chain support
export {isChainSupported, SUPPORTED_CHAINS} from './trezor/chains'
export {createTrezorDevice, fromTrezorPath, toTrezorPath} from './trezor/device'
export {
  extractTrezorError,
  isAuxiliaryNotSupportedError,
  isConnectionError,
  isConwayNotSupportedError,
  isFeatureNotSupportedError,
  isIframeTimeoutError,
  isPassphraseMismatchError,
  isPermissionDeniedError,
  isTransferError,
  isUserRejectionError,
  mapTrezorError,
} from './trezor/errors'
export type {
  TrezorBitcoin,
  TrezorBitcoinCash,
  TrezorBitcoinInput,
  TrezorBitcoinOptions,
  TrezorBitcoinOutput,
  TrezorConnectMultichain,
  TrezorDogecoin,
  TrezorEIP712Data,
  TrezorEthereum,
  TrezorEthereumSignature,
  TrezorEthereumTx,
  TrezorLitecoin,
  TrezorSolana,
  TrezorSolanaSignature,
} from './trezor/multichain'
// Multichain support
export {
  createTrezorBitcoin,
  createTrezorBitcoinCash,
  createTrezorDogecoin,
  createTrezorEthereum,
  createTrezorLitecoin,
  createTrezorSolana,
} from './trezor/multichain'
export type {
  TrezorCardanoAddressParams,
  TrezorCardanoAddressType,
  TrezorCardanoAssetGroup,
  TrezorCardanoCertificate,
  TrezorCardanoCertificateType,
  TrezorCardanoGetAddressRequest,
  TrezorCardanoGetAddressResponse,
  TrezorCardanoGetPublicKeyRequest,
  TrezorCardanoGetPublicKeyResponse,
  TrezorCardanoInput,
  TrezorCardanoOutput,
  TrezorCardanoSignMessageRequest,
  TrezorCardanoSignMessageResponse,
  TrezorCardanoSignTxRequest,
  TrezorCardanoSignTxResponse,
  TrezorCardanoToken,
  TrezorCardanoWithdrawal,
  TrezorConnectionState,
  TrezorDeviceEvent,
  TrezorInitOptions,
  TrezorManifest,
  TrezorResponse,
  TrezorUIEvent,
} from './trezor/types'
