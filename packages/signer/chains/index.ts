/**
 * Generic signer types and key derivation.
 *
 * Chain-specific signer implementations were removed when the wallet was
 * trimmed to Midnight-only. What remains is the generic BIP-32 secp256k1
 * derivation (the mechanism behind the future Midnight derivation path,
 * m/44'/2400') and the shared error/metadata types.
 *
 * Import via `@pnyx/signer/chains`.
 *
 * @module
 */

// Key derivation
export {deriveSecp256k1Key, deriveSecp256k1PrivateKey} from './keys.js'

// Shared types and errors
export {
  type ChainId,
  ChainSignerError,
  type ChainSignerErrorType,
  type ChainSignerInfo,
  ChainSignerNotConnectedError,
  ChainSignerTimeoutError,
  ChainSignerUserRejectedError,
} from './types.js'
